# Goal

Build a minimal but extensible 2D game engine baseline called "TigerEngine" in C or C++ that runs as a native desktop application.
The engine must provide a core loop, entity-component architecture, rendering pipeline, input handling, and a basic scene/asset system.
Additionally, it must include a GUI-based editor that allows visual manipulation of scenes, entities, and assets—similar to typical game engines (Unity, Godot, Unreal).

## Background

We want to validate openTiger's ability to drive complex, multi-subsystem software with real-time constraints.
A game engine spans rendering, lifecycle, state management, editor tooling, and cross-cutting performance concerns.
A minimal but structurally sound baseline with a usable editor will establish whether autonomous iteration can handle such workloads.

## Constraints

- Language: C or C++ (C++ recommended for RAII, STL, and component patterns)
- Build system: CMake
- Target: Native desktop (Linux, macOS, or Windows; at least one platform)
- Define and document one primary developer target and one CI target (for example: desktop Linux + headless Linux CI)
- Graphics: OpenGL 3.3+ (Core Profile) or equivalent
- Window/context: GLFW or SDL
- Editor GUI: Dear ImGui (imgui) or equivalent immediate-mode UI library
- Keep frame timing and update logic deterministic enough for automated tests
- Keep at least one non-interactive visual validation path that does not rely on manual screen observation
- Prioritize incremental, testable slices over monolithic rewrites

## Acceptance Criteria

### Core Loop and Lifecycle

- [ ] Engine bootstraps and enters main loop with configurable target FPS
- [ ] Update tick runs at fixed timestep (e.g. 60 updates/sec) with delta accumulation for stability
- [ ] Render pass runs after update; frame timing is measurable
- [ ] Engine supports start, pause, resume, and shutdown with clean resource teardown
- [ ] A minimal `Engine::run()` entry point exists and is testable in isolation (mock render/input)

### Entity-Component Architecture

- [ ] Entities are identifiable containers; components can be added, removed, queried
- [ ] At least `Transform` (position, rotation, scale) and `Sprite` (texture reference, rect) components exist
- [ ] System/processor pattern: `TransformSystem` and `RenderSystem` process entities with required components
- [ ] Component addition/removal during iteration is deferred to avoid modification-during-iteration bugs
- [ ] Entity and component creation/destruction has no memory leaks under basic stress (1000 create/destroy cycles)

### Rendering Pipeline

- [ ] OpenGL context is acquired and initialized with sensible defaults
- [ ] 2D orthographic projection with configurable viewport and camera (position, zoom)
- [ ] Simple textured quad batch renderer: at least 100 sprites per frame at 60 FPS on mid-range hardware
- [ ] Texture loading from file paths with caching; placeholder texture for missing/failed loads
- [ ] Basic layer/ordering: render order by entity property (e.g. `zIndex` or `layer`)
- [ ] Viewport resize on window resize
- [ ] Automated visible-frame smoke validation exists (for example, framebuffer readback with clear-color ratio threshold) and fails when output is effectively clear-only/black-only

### Input Handling

- [ ] Keyboard: key down/up events exposed to systems with key code and repeat handling
- [ ] Mouse: position (viewport space), button down/up, wheel
- [ ] Input state is queryable (e.g. `Input::isKeyDown(Key::Right)`)
- [ ] Input handling does not block main loop; events are batched and consumed in update tick
- [ ] Editor and game input are separable (editor captures input when viewport not focused)

### Scene and Asset System

- [ ] Scene has a root container; entities can be added as children with hierarchical transform
- [ ] Scene loading from JSON descriptor (entity list, components, basic properties)
- [ ] Asset manifest: preload textures by path; loading progress callback during load
- [ ] Basic asset hot-reload in dev mode (file change triggers reload)
- [ ] Scene save: persist current scene to JSON from editor

### Editor GUI

- [ ] Main window with menu bar (File: New Scene, Open, Save, Save As, Exit; Edit: Undo basic support; View: panel visibility toggles)
- [ ] Scene hierarchy panel: tree view of entities; select entity on click; add/remove entity buttons; entity rename
- [ ] Inspector panel: when entity selected, show editable properties of all components (Transform position/rotation/scale; Sprite texture path, rect); changes apply immediately to scene
- [ ] Game viewport panel: renders the current scene; camera pan/zoom with mouse; click to select entity under cursor (optional, can select via hierarchy only initially)
- [ ] Asset browser panel: list textures in asset directory; drag texture onto entity or Sprite component to assign
- [ ] Toolbar: Play (run game loop), Pause, Stop buttons; Create Entity button
- [ ] Editor and game runtime modes: in Edit mode, changes persist; in Play mode, scene state can reset on Stop
- [ ] All panels are dockable/resizable (ImGui docking or manual layout)
- [ ] Editor startup provides at least one immediately visible element in viewport/UI (sample sprite, grid, or diagnostic overlay) to avoid "blank-but-running" ambiguity

### Verification and Quality

- [ ] Headless test mode: engine core (ECS, math, scene) runs without OpenGL/window for unit tests
- [ ] At least one automated smoke test that creates engine, adds entities, runs N ticks, asserts no crash
- [ ] Unit tests for ECS (entity/component add/remove/query), transform math, and input state
- [ ] Example game (e.g. simple top-down mover or collectible demo) runs in Play mode and is playable
- [ ] Build and tests pass via CMake (build, ctest or equivalent)
- [ ] Visual probe test path is CI-runnable (or explicitly skipped with reason code) and stores image + metrics artifacts for diagnosis
- [ ] Verification gates include both command success and output quality checks (not command success alone)
- [ ] Documentation: setup, architecture overview, editor usage, and extension points

## Scope

### In Scope

- Engine core: loop, lifecycle, tick accumulator
- ECS: entity, component, system/processor pattern
- Transform and hierarchy (local/world space)
- OpenGL renderer: ortho camera, textured quads, batching
- Input manager: keyboard, mouse, event batching
- Scene format (JSON) and loader/saver
- Asset preloader and texture cache
- Editor GUI: hierarchy, inspector, viewport, asset browser, toolbar, menu bar
- Edit/Play mode distinction
- Headless test harness and smoke tests
- Example mini-game demonstrating engine usage
- Architecture and setup documentation

### Out of Scope

- 3D rendering, lighting, advanced shaders beyond basic 2D
- Physics engine (collision, rigid bodies)
- Audio system
- Animation system (keyframes, spritesheets)
- Network multiplayer
- Scripting system (Lua, etc.)
- Asset pipeline (spritesheet packing, atlas generation)
- Multi-platform build matrix (focus on one platform first)
- Undo/redo beyond basic stub

## Allowed Paths

- `CMakeLists.txt`
- `engine/`
  - `core/`
  - `ecs/`
  - `render/`
  - `input/`
  - `assets/`
  - `editor/`
- `editor/`
- `engine-demo/`
- `engine-tests/`
- `cmake/`
- `docs/engine/**`
- `scripts/engine-*`

## Risk Assessment

| Risk                                                        | Impact | Mitigation                                                            |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| OpenGL context/extension issues across platforms            | high   | Target single platform first; document GL version and extensions      |
| ECS modification-during-iteration causes undefined behavior | high   | Defer add/remove to end of system tick; document iteration rules      |
| Variable frame rate causes non-deterministic simulation     | medium | Fixed timestep update with accumulator; render interpolation optional |
| ImGui input conflicts with game input                       | medium | Clear input ownership; editor captures when interacting with panels   |
| Editor state and game state get out of sync in Play mode    | high   | Explicit Edit/Play separation; reset scene on Stop                    |
| Scope creep into physics/audio/scripting blocks delivery    | high   | Strict Out of Scope; defer to follow-up milestones                    |

## Notes

Milestone-first strategy suggested:

1. Core loop + lifecycle + headless test harness
   - Exit criteria: fixed-step test passes; clean shutdown test passes.
2. ECS (entity, component, Transform, basic system)
   - Exit criteria: add/remove/query tests pass; deferred-mutation test passes.
3. OpenGL init + ortho camera + single quad render
   - Exit criteria: OpenGL init smoke passes; visible-frame smoke fails on forced clear-only frame.
4. Input manager + event batching
   - Exit criteria: key/mouse event ordering tests pass; no blocking in frame loop.
5. Texture loading + sprite batch renderer
   - Exit criteria: texture cache and missing-texture fallback tests pass.
6. Scene JSON loader + hierarchy
   - Exit criteria: load/save round-trip test passes.
7. ImGui integration + window layout
   - Exit criteria: editor window opens and reports at least one visible panel region.
8. Editor: hierarchy panel + inspector + viewport (read-only select)
   - Exit criteria: selection synchronization tests pass (hierarchy <-> viewport).
9. Editor: asset browser + drag-assign, toolbar, menu bar
   - Exit criteria: drag-assign and menu smoke tests pass.
10. Edit/Play mode + scene save
    - Exit criteria: pre-play snapshot restore test passes.
11. Example game + documentation
    - Exit criteria: playable demo smoke + docs checklist complete.

For openTiger operation, ensure at least one non-interactive verification path (e.g. `ctest` or `./engine-tests`) that does not require a display.
Keep system boundaries explicit so planner can decompose into separate modules/tasks.
