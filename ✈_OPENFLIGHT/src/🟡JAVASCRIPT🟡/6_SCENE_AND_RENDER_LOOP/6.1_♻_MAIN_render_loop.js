/***************************************************************
 * 6.1_♻_MAIN_render_loop.js
 *
 * Keeps a single global `engine` and `scene` so helper scripts
 * ("draw_forces_and_velocities.js" etc.) see the same object,
 * updates the debug visualizations each frame, and sends pilot
 * inputs to the Julia physics server.
 *
 * IMPORTANT:
 * Browser-side dead reckoning of the aircraft pose is intentionally
 * DISABLED here. A previous client predictor integrated the pose from
 * wx/wy/wz and then fed that predicted quaternion back into the
 * server on the next frame, which could corrupt the pitch dynamics.
 * The Julia solver is the single source of truth for physics state.
 ***************************************************************/

// Wait for the DOM content to be fully loaded before initializing Babylon
window.addEventListener("DOMContentLoaded", () => {
    /*------------------------------------------------------------
     * ENGINE + SCENE (use the globals declared in initialisations)
     *-----------------------------------------------------------*/
    const canvas = document.getElementById("renderCanvas");

    // Ensure canvas exists
    if (!canvas) {
        console.error("renderCanvas not found in the DOM!");
        return;
    }

    // Initialize the Babylon engine (assigns to global 'engine')
    engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        limitDeviceRatio: 1.0 // Optional: Limit device pixel ratio for performance
    });
    window.engine = engine; // Expose engine globally if needed elsewhere

    // Create the Babylon scene (assigns to global 'scene' via createScene function)
    // createScene itself should assign to window.scene
    scene = createScene(engine, canvas);

    // Verify scene creation
    if (!scene) {
        console.error("Scene creation failed!");
        return;
    }
    // Ensure window.scene is set if createScene doesn't do it reliably
    if (!window.scene) {
        window.scene = scene;
    }

    /*------------------------------------------------------------
     * POSE SMOOTHING
     *
     * The Julia physics server replies at a variable rate dictated by
     * WebSocket round-trip time + RK4 compute time (~30-50 Hz), while
     * the browser renders at vSync (60-120 Hz). If we wrote server-
     * reported x/y/z/qxyzw straight into aircraft.position and
     * aircraft.rotationQuaternion, the mesh would teleport on reply
     * frames and freeze on all frames in between — perceived as
     * jerky motion even when the physics itself is perfectly smooth.
     *
     * Instead, 1.1_..._exchange_aircraft_state_with_server.js stores
     * the latest authoritative pose in window.authoritativePosition
     * (for position) and the existing global `orientation` quaternion
     * (for attitude). Each render frame we exponentially approach
     * those targets with a frame-rate-independent smoothing step. The
     * authoritative values are what gets echoed back to the server —
     * the smoothing affects ONLY the visual transform.
     *
     * Smoothing half-life = 40 ms: the rendered pose closes half the
     * remaining gap to the target every 40 ms. At 60 fps this is ~0.25
     * per frame. Steady-state lag is ~40 ms, imperceptible compared to
     * the pilot-to-server round-trip, and dramatically hides all jitter.
     *-----------------------------------------------------------*/
    const POSE_SMOOTH_HALFLIFE_MS = 40;
    // Pre-allocate the Quaternion used as the SLERP target so we do not
    // allocate once per frame at 120 fps.
    const _smoothingTargetQuaternion = new BABYLON.Quaternion(0, 0, 0, 1);

    function _smoothAircraftPoseTowardAuthoritative(dtMs) {
        if (!aircraft || !window.authoritativePosition || !window.initialDataReceived) {
            return;
        }
        // Frame-rate-independent exponential smoothing.
        const alpha = 1.0 - Math.pow(0.5, dtMs / POSE_SMOOTH_HALFLIFE_MS);
        aircraft.position.x += (window.authoritativePosition.x - aircraft.position.x) * alpha;
        aircraft.position.y += (window.authoritativePosition.y - aircraft.position.y) * alpha;
        aircraft.position.z += (window.authoritativePosition.z - aircraft.position.z) * alpha;
        if (aircraft.rotationQuaternion && typeof orientation !== 'undefined') {
            _smoothingTargetQuaternion.set(
                orientation.x, orientation.y, orientation.z, orientation.w
            );
            BABYLON.Quaternion.SlerpToRef(
                aircraft.rotationQuaternion,
                _smoothingTargetQuaternion,
                alpha,
                aircraft.rotationQuaternion
            );
        }
    }

    /*------------------------------------------------------------
     * STARTUP / PAUSE OVERLAY STATE MACHINE
     *
     * The #glbLoadingOverlay div is baked into the HTML body so the
     * user sees "Loading…" the instant the page parses — before Babylon,
     * the scene, or the WebSocket handshake have a chance to run.
     *
     * Four visible states, driven by this function once per frame:
     *   1. LOADING — !window.initialDataReceived OR window.isGlbLoading
     *        Text is whatever the GLB loader / initial HTML set it to
     *        ("Loading…" or "Loading aircraft model (…)"). We don't
     *        touch it here so the more specific GLB progress label wins.
     *   2. READY TO START — loaded AND paused AND never run yet
     *        Text becomes "Simulation ready, press space to start".
     *        window.simReadyToPlay latches true so the keyboard/gamepad
     *        handlers in 3.1_... are allowed to un-pause.
     *   3. PAUSED AFTER STARTED — loaded AND paused AND has run before
     *        Text becomes "Paused, press space to continue".
     *        Re-appears every time the pilot pauses mid-flight; vanishes
     *        again on un-pause. This is why the "startup" latch that
     *        used to hide the overlay for good was removed — the pause
     *        prompt needs to re-show on every pause.
     *   4. HIDDEN — sim is running (!isPaused)
     *        display:none; pilot is flying.
     *-----------------------------------------------------------*/
    window.simReadyToPlay = false;

    function _updatePauseOrLoadingOverlay() {
        const overlay = document.getElementById('glbLoadingOverlay');
        if (!overlay) return;

        const loaded = window.initialDataReceived && !window.isGlbLoading;
        if (!loaded) {
            // Still loading — leave the text alone so whatever message
            // the GLB loader set ("Loading aircraft model (…)") stays
            // visible. Just ensure the overlay itself is shown.
            if (overlay.style.display === 'none') overlay.style.display = 'flex';
            return;
        }

        // Once we reach "loaded", latch simReadyToPlay so un-pause is
        // allowed. We never clear this — subsequent pauses don't block
        // un-pause again, they just change the overlay text.
        if (!window.simReadyToPlay) {
            window.simReadyToPlay = true;
            console.log("Simulator ready — press space to begin.");
        }

        const paused = (typeof isPaused !== 'undefined') ? !!isPaused : true;
        if (!paused) {
            // Flying — hide the overlay. Cheap to set display repeatedly.
            if (overlay.style.display !== 'none') overlay.style.display = 'none';
            return;
        }

        // Paused while loaded. Pick the message based on whether the
        // user has ever un-paused yet.
        const hasStarted = (typeof hasStartedOnce !== 'undefined') ? !!hasStartedOnce : false;
        const message = hasStarted
            ? 'Paused, press space to continue'
            : 'Simulation ready, press space to start';
        if (overlay.textContent !== message) overlay.textContent = message;
        if (overlay.style.display === 'none') overlay.style.display = 'flex';
    }
    // Backwards-compat alias — an earlier name for this function; kept
    // in case anything else ever called it by the old name.
    const _maybeHideStartupLoadingOverlay = _updatePauseOrLoadingOverlay;

    /*------------------------------------------------------------
     * MAIN RENDER LOOP
     *-----------------------------------------------------------*/
    engine.runRenderLoop(() => {
        // Hide the page-level "Loading…" overlay as soon as the sim is
        // ready to be unpaused. Cheap check; safe to run every frame.
        _maybeHideStartupLoadingOverlay();

        // Smooth the visual aircraft pose toward the authoritative server
        // pose BEFORE anything else in this frame reads `aircraft.position`
        // or `aircraft.rotationQuaternion`.
        //
        // Order matters: updateVelocityLine / updateForceLine / updateTrajectory
        // all read the aircraft transform (directly or via localPointToWorld
        // which calls aircraft.getWorldMatrix()). If pose smoothing ran AFTER
        // them, the attached visuals would be computed against last frame's
        // pose while scene.render() drew the aircraft at this frame's pose —
        // a one-frame mismatch that shows up as all force arrows trembling
        // at render rate as the aircraft rotates.
        _smoothAircraftPoseTowardAuthoritative(engine.getDeltaTime());

        // Handle gamepad pause/resume controls first
        // Assumes handleGamepadPauseControls uses global 'isPaused'
        if (typeof handleGamepadPauseControls === 'function') {
            handleGamepadPauseControls();
        }

        // --- Simulation Logic (only when not paused) ---
        if (!isPaused && !simulationEnded) {
            // Get pilot inputs (keyboard/gamepad)
            // Pass scene if the function requires it (check its definition)
            if (typeof updateForcesFromJoystickOrKeyboard === 'function') {
                updateForcesFromJoystickOrKeyboard(scene);
            }

            // Send the last server-authoritative state back to the server
            // together with the latest pilot inputs. Do not integrate a
            // browser-side predicted pose here.
            // Checks WebSocket connection internally
            if (typeof sendStateToServer === 'function') {
                sendStateToServer();
            }

            // Update trajectory visualization based on server time.
            // Reads aircraft.position to drop each new sphere at the
            // smoothed visual position so the trail matches the visible
            // aircraft, not the authoritative-lagged one.
            const serverTime = window.serverElapsedTime || 0;
            if (typeof updateTrajectory === 'function') {
                updateTrajectory(serverTime);
            }
        }

        // --- Visualization Updates (run even when paused, but depend on data) ---

        // Update vectors continuously; each updater validates data internally.
        const velocityVectorsEnabled = (show_velocity_vectors === "true" || show_velocity_vectors === true);
        const forceVectorsEnabled = (show_force_vectors === "true" || show_force_vectors === true);

        if (typeof updateVelocityLine === 'function') {
            updateVelocityLine(scene); // Pass scene
        }
        if (typeof updateForceLine === 'function') {
            updateForceLine(scene); // Pass scene
        }

        // Update GUI display text if aircraft exists
        // Assumes updateInfo uses global variables like 'aircraft', 'velocity', etc.
        if (aircraft && typeof updateInfo === 'function') {
            updateInfo();
        }

        // Render the scene
        if (scene && scene.isReady()) { // Check if scene is ready
            scene.render();
        }
    });

    /*------------------------------------------------------------
     * WINDOW / GAMEPAD EVENTS
     *-----------------------------------------------------------*/
    // Handle window resize
    window.addEventListener("resize", () => {
        if (engine) {
            engine.resize();
        }
    });

    // Handle gamepad connection/disconnection
    window.addEventListener("gamepadconnected", (e) => {
        // Ensure gamepad property exists
        if (e.gamepad) {
            gamepadIndex = e.gamepad.index;
            console.log(`Gamepad connected (index ${gamepadIndex}, ID: ${e.gamepad.id})`);
        } else {
            console.warn("Gamepad connected event fired without gamepad data.");
        }
    });

    window.addEventListener("gamepaddisconnected", (e) => {
        // Ensure gamepad property exists
        if (e.gamepad) {
            console.log(`Gamepad disconnected (index ${e.gamepad.index}, ID: ${e.gamepad.id})`);
            // Only reset index if the disconnected gamepad is the one we were tracking
            if (gamepadIndex === e.gamepad.index) {
                gamepadIndex = null;
            }
        } else {
            console.warn("Gamepad disconnected event fired without gamepad data.");
        }
    });
});
