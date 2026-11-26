# Load submitted assets in Godot 4 and observe real playback and keyboard movement.
# Import the project's PNG first (godot --headless --path PROJECT --import).
# godot --headless --fixed-fps 60 --path PROJECT --script /abs/grade_playback.gd -- CASE res://actor.tres /abs/actor.atlas.json
# For profile/porter, copy their .tres and sheet into an empty project. Scout/transfer use the submitted default project.
extends SceneTree

const DIRECTIONS := {
	"right": [Vector2.RIGHT, KEY_RIGHT], "left": [Vector2.LEFT, KEY_LEFT],
	"down": [Vector2.DOWN, KEY_DOWN], "up": [Vector2.UP, KEY_UP],
}
const STEP_MS := {"profile": 100, "porter": 100, "scout": 100, "transfer": 120, "watchmaker": 120}

var errors: Array[String] = []
var report := {"clips": {}, "controls": {}}
var atlas: Dictionary
var frames: SpriteFrames
var expected_sheet: Image
var checked_sheets := {}
var step_ms: int
var watchdog := 0

func _initialize() -> void:
	run.call_deferred()

func _process(_delta: float) -> bool:
	watchdog += 1
	if watchdog == 18000:
		errors.append("The grader did not finish within 18000 process frames.")
		finish()
	return false

func finish() -> void:
	report.errors = errors
	report.machine_pass = errors.is_empty()
	print(JSON.stringify(report))
	quit(0 if errors.is_empty() else 1)

func run() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 3 or not STEP_MS.has(args[0]):
		errors.append("Expected CASE, SpriteFrames resource path and atlas JSON path.")
		finish()
		return
	report["case"] = args[0]
	step_ms = STEP_MS[args[0]]
	frames = load(ProjectSettings.localize_path(args[1].replace("\\", "/"))) as SpriteFrames
	var atlas_path := args[2].replace("\\", "/")
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(atlas_path))
	if not frames or not parsed is Dictionary or not parsed.get("animations") is Dictionary or not parsed.get("frames") is Dictionary or not parsed.get("meta") is Dictionary:
		errors.append("Cannot load SpriteFrames or atlas metadata.")
		finish()
		return
	atlas = parsed
	var png: String = atlas.meta.get("image", "")
	if png.get_extension().to_lower() == "png":
		expected_sheet = Image.load_from_file(ProjectSettings.globalize_path(atlas_path.get_base_dir().path_join(png)))
	if not expected_sheet or expected_sheet.is_empty():
		errors.append("Cannot read the PNG named by atlas.meta.image.")
		finish()
		return
	expected_sheet.convert(Image.FORMAT_RGBA8)
	var sprite := AnimatedSprite2D.new()
	sprite.sprite_frames = frames
	root.add_child(sprite)
	var directions: Array = ["right"] if args[0] == "profile" else DIRECTIONS.keys()
	for direction in directions:
		for kind in ["stand-", "walk-"]:
			await grade_clip(sprite, kind + direction, kind == "walk-")
	sprite.free()
	if args[0] in ["scout", "transfer", "watchmaker"]:
		await grade_project()
	finish()

func size_of(d: Dictionary) -> Vector2:
	return Vector2(d.get("w", -1), d.get("h", -1))

func pos_of(d: Dictionary) -> Vector2:
	return Vector2(d.get("x", -1), d.get("y", -1))

func sheet_matches(texture: Texture2D) -> bool:
	var image := texture.get_image()
	if not image or image.get_size() != expected_sheet.get_size():
		return false
	image.convert(Image.FORMAT_RGBA8)
	if image.get_data() == expected_sheet.get_data():
		return true
	# Godot's PNG importer may replace the hidden RGB of transparent pixels to avoid fringes.
	for y in image.get_height():
		for x in image.get_width():
			var actual := image.get_pixel(x, y)
			var expected := expected_sheet.get_pixel(x, y)
			if actual != expected and (actual.a8 != 0 or expected.a8 != 0):
				return false
	return true

func check_texture(texture: AtlasTexture, entry: Dictionary) -> bool:
	if not texture or not texture.atlas:
		return false
	var sheet := texture.atlas
	if not checked_sheets.has(sheet):
		checked_sheets[sheet] = sheet_matches(sheet)
	var region: Dictionary = entry.get("frame", {})
	var cropped: Dictionary = entry.get("spriteSourceSize", {})
	var size := size_of(entry.get("sourceSize", {}))
	var expected := Rect2(pos_of(region), size_of(region))
	return (checked_sheets[sheet] and sheet.get_size() == size_of(atlas.meta.get("size", {}))
		and not entry.get("rotated", false) and texture.region == expected and expected.has_area()
		and Rect2(Vector2.ZERO, sheet.get_size()).encloses(expected)
		and texture.get_size() == size and size_of(cropped) == expected.size
		and texture.margin == Rect2(pos_of(cropped), size - expected.size))

func grade_clip(sprite: AnimatedSprite2D, clip: String, walking: bool) -> void:
	var metadata = atlas.animations.get(clip, {})
	var names = metadata.get("frames") if metadata is Dictionary else null
	if not frames.has_animation(clip) or not names is Array or names.is_empty() or frames.get_frame_count(clip) != names.size():
		errors.append("%s: missing animation or frame count differs from atlas." % clip)
		return
	var speed := frames.get_animation_speed(clip)
	var looping := frames.get_animation_loop(clip)
	if speed <= 0 or looping != metadata.get("loop") or (walking and (not looping or names.size() < 2)):
		errors.append("%s: invalid speed, loop mode or walk frame count." % clip)
		return
	var total_ms := 0.0
	for i in names.size():
		var entry = atlas.frames.get(names[i], {})
		if not entry is Dictionary or not check_texture(frames.get_frame_texture(clip, i) as AtlasTexture, entry):
			errors.append("%s[%d]: wrong sheet, region, source size or trim margin." % [clip, i])
			return
		var ms := 1000.0 * frames.get_frame_duration(clip, i) / speed
		if absf(ms - float(entry.get("duration", -1))) > 0.001 or (walking and absf(ms - step_ms) > 0.001):
			errors.append("%s[%d]: playback step %.3f ms disagrees with expected duration." % [clip, i, ms])
			return
		total_ms += ms
	if absf(total_ms - float(metadata.get("duration", -1))) > 0.01:
		errors.append("%s: total duration differs from atlas." % clip)
		return
	sprite.stop()
	sprite.play(clip)
	report.clips[clip] = {"frames": names.size(), "total_ms": roundi(total_ms), "loop": looping}
	if not walking:
		await process_frame
		if sprite.animation != clip or sprite.frame != 0:
			errors.append("%s: stand did not start at its first frame." % clip)
		return
	# Observe the next frame at every 60 Hz tick, including the transition from the last to the first.
	var previous := 0
	var changes := 0
	var elapsed_ms := 0.0
	for tick in mini(3600, ceili(total_ms * 0.06) + 8):
		await process_frame
		var tick_ms := sprite.get_process_delta_time() * 1000.0
		elapsed_ms += tick_ms
		if sprite.frame == previous:
			continue
		changes += 1
		if sprite.frame != (previous + 1) % names.size() or absf(elapsed_ms - changes * step_ms) > 2.01 * tick_ms:
			errors.append("%s: unexpected frame %d at %.1f ms." % [clip, sprite.frame, elapsed_ms])
			return
		previous = sprite.frame
		if changes == names.size():
			report.clips[clip]["observed_loop_ms"] = roundi(elapsed_ms)
			return
	errors.append("%s: did not play every frame and wrap in time." % clip)

func send_key(code: int, pressed: bool) -> void:
	var event := InputEventKey.new()
	event.keycode = code
	event.physical_keycode = code
	event.pressed = pressed
	Input.parse_input_event(event)
	Input.flush_buffered_events()

func grade_project() -> void:
	var path: String = ProjectSettings.get_setting("application/run/main_scene", "")
	if path.is_empty() or change_scene_to_file(path) != OK:
		errors.append("Cannot launch the configured main scene.")
		return
	for tick in 5:
		await process_frame
	if not current_scene:
		errors.append("The project did not open a scene.")
		return
	var nodes := current_scene.find_children("*", "AnimatedSprite2D", true, false)
	nodes.push_front(current_scene)
	var actor: AnimatedSprite2D
	for node in nodes:
		if node is AnimatedSprite2D and node.sprite_frames == frames and node.is_visible_in_tree():
			actor = node
			break
	if not actor:
		errors.append("The main scene has no visible AnimatedSprite2D using the submitted resource.")
		return
	report.main_scene = current_scene.scene_file_path
	for direction in DIRECTIONS:
		var keys: Array = DIRECTIONS[direction]
		var result: Dictionary = await probe_input(actor, direction, keys[1])
		report.controls[direction] = result
		if not (result.moved and result.frames_seen >= 2 and result.stood and result.ground and result.speed_ok):
			errors.append("%s: main-scene input, playback, stopping or ground placement failed." % direction)

func probe_input(sprite: AnimatedSprite2D, direction: String, key: int) -> Dictionary:
	# Track local movement to locate the actual moving body whether the script drives a parent or the sprite itself.
	var ancestors := []
	var node: Node = sprite
	while node is Node2D:
		ancestors.append({"node": node, "start": node.position, "max_ground_error": 0.0})
		node = node.get_parent()
	var start := sprite.global_position
	var observed := {}
	var speed_ok := true
	var previous_frame := -1
	var last_change := -1
	var heading: Vector2 = DIRECTIONS[direction][0]
	send_key(key, true)
	for tick in 24:
		await process_frame
		if sprite.animation == "walk-" + direction and sprite.is_playing():
			observed[sprite.frame] = true
			speed_ok = speed_ok and is_equal_approx(sprite.get_playing_speed(), 1.0)
			if previous_frame >= 0 and previous_frame != sprite.frame:
				var count := frames.get_frame_count(sprite.animation)
				speed_ok = speed_ok and sprite.frame == (previous_frame + 1) % count
				if last_change >= 0:
					speed_ok = speed_ok and absf((tick - last_change) - step_ms * 0.06) <= 1.01
				last_change = tick
			previous_frame = sprite.frame
			measure_ground(sprite, ancestors)
	var delta := sprite.global_position - start
	var body: Dictionary = ancestors[0]
	for candidate in ancestors:
		if not candidate.node.position.is_equal_approx(candidate.start):
			body = candidate
	send_key(key, false)
	for tick in 3:
		await process_frame
	var stop := sprite.global_position
	var stood := true
	for tick in 12:
		await process_frame
		stood = stood and sprite.animation == "stand-" + direction and sprite.global_position.distance_to(stop) < 0.05
		measure_ground(sprite, [body])
	return {"key": OS.get_keycode_string(key), "moved": delta.dot(heading) > 0.1 and absf(delta.cross(heading)) < 0.1,
		"delta": [snappedf(delta.x, 0.01), snappedf(delta.y, 0.01)], "frames_seen": observed.size(),
		"stood": stood, "speed_ok": speed_ok, "ground": body.max_ground_error < 0.01}

func measure_ground(sprite: AnimatedSprite2D, ancestors: Array) -> void:
	var anim = atlas.animations.get(str(sprite.animation), {})
	var names = anim.get("frames", []) if anim is Dictionary else []
	var point := Vector2(INF, INF)
	if names is Array and sprite.frame < names.size():
		var entry: Dictionary = atlas.frames.get(names[sprite.frame], {})
		var size := size_of(entry.get("sourceSize", {}))
		var pivot := Vector2(INF, INF)
		if entry.get("anchorPx") is Dictionary:
			pivot = pos_of(entry.anchorPx)
		elif entry.get("pivot") is Dictionary:
			pivot = pos_of(entry.pivot) * size
		elif entry.get("anchor") is Dictionary:
			pivot = pos_of(entry.anchor)
		if pivot.is_finite():
			if sprite.flip_h:
				pivot.x = size.x - pivot.x
			if sprite.flip_v:
				pivot.y = size.y - pivot.y
			point = sprite.to_global(sprite.offset + pivot - (size * 0.5 if sprite.centered else Vector2.ZERO))
	for body in ancestors:
		body.max_ground_error = maxf(body.max_ground_error, point.distance_to(body.node.global_position))
