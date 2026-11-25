"""Render submitted and reference motion side by side from native facts. Requires Pillow."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

from score import native


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("family", type=Path)
    parser.add_argument("submission", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--variant", choices=("clean","damaged"), default="damaged")
    parser.add_argument("--baseline", type=Path, help="Optional fourth column for the baseline submission")
    args = parser.parse_args()
    sources = [args.family/(args.variant+".poses.json")]
    titles = ["Supplied"]
    if args.baseline:
        sources.append(args.baseline)
        titles.append("Baseline")
    sources.extend([args.submission,args.family/"clean.poses.json"])
    titles.extend(["Candidate" if args.baseline else "Agent result","Artist reference"])
    columns = [native(args.package,path) for path in sources]
    original = columns[0]
    clips = [(key,seq) for key,seq in original["clips"].items() if seq.get("rest")]
    if not clips:
        raise ValueError("expected authored walk cycles")
    # Use each clip's native playback clock, even if different facings use different durations.
    from math import lcm
    slot_lengths = [[sum(data["frames"][n]["duration"] for n in data["clips"][key]["frames"])
                     for data in columns] for key,_ in clips]
    loops = [length for row in slot_lengths for length in row]
    period = min(lcm(*loops), max(loops)*2)
    times = {0,period}
    timelines = []
    for (key,_),lengths in zip(clips,slot_lengths):
        row = []
        for data,length in zip(columns,lengths):
            ends, at = [], 0
            for name in data["clips"][key]["frames"]:
                at += data["frames"][name]["duration"]
                ends.append(at)
            row.append(ends)
            times.update(start+end for start in range(0,period,length) for end in ends if start+end <= period)
        timelines.append(row)
    times = sorted(times)
    w,h,z = original["width"],original["height"],4
    margin, label, header = 9,76,30
    colw = max(w*z+2*margin,112)
    rowh = h*z+2*margin
    images = []
    font = ImageFont.load_default(size=14)
    for t in times[:-1]:
        canvas = Image.new("RGB",(label+len(titles)*colw,header+len(clips)*rowh),"#f6f3eb")
        draw = ImageDraw.Draw(canvas)
        for index,title in enumerate(titles):
            draw.text((label+(index+.5)*colw,header/2),title,fill="#253342",font=font,anchor="mm")
        for row,((key,seq),ends,lengths) in enumerate(zip(clips,timelines,slot_lengths)):
            y = row*rowh+header
            draw.rectangle((0,y,canvas.width,y+rowh-2),fill=["#e0e8e6","#e9e4ed"][row%2])
            draw.text((8,y+rowh/2),seq["direction"].capitalize(),font=font,fill="#253342",anchor="lm")
            for index,data in enumerate(columns):
                phase = next(i for i,end in enumerate(ends[index]) if t%lengths[index] < end)
                name = data["clips"][key]["frames"][phase]
                pic = Image.frombytes("RGBA",(w,h),data["frames"][name]["rgba"]).resize((w*z,h*z),Image.Resampling.NEAREST)
                canvas.paste(pic,(label+index*colw+(colw-w*z)//2,y+margin),pic)
        images.append(canvas)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    images[0].save(args.out,save_all=True,append_images=images[1:],duration=[b-a for a,b in zip(times,times[1:])],loop=0,disposal=2)


if __name__ == "__main__":
    main()
