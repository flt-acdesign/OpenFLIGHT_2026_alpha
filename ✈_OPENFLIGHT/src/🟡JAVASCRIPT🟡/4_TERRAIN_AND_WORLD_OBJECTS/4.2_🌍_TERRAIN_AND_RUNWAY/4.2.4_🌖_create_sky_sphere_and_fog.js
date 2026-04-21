

/***************************************************************
 * Creates a large sky sphere with a vertical gradient texture.
 * Automatically positions it based on the active camera.
 **************************************************************/
const DEFAULT_SKY_SPHERE_DIAMETER = 7000;
const LOW_DETAIL_SKY_DIAMETER_MARGIN = 2000;
const FALLBACK_LOW_DETAIL_GROUND_BOARD_SIZE = 15000;

function _getLowDetailGroundBoardSize() {
    if (
        typeof window !== "undefined" &&
        Number.isFinite(window.lowDetailGroundBoardSize) &&
        window.lowDetailGroundBoardSize > 0
    ) {
        return window.lowDetailGroundBoardSize;
    }

    const groundRoot = (typeof window !== "undefined") ? window.ground : null;
    if (
        groundRoot &&
        groundRoot.metadata &&
        Number.isFinite(groundRoot.metadata.boardSize) &&
        groundRoot.metadata.boardSize > 0
    ) {
        return groundRoot.metadata.boardSize;
    }

    return FALLBACK_LOW_DETAIL_GROUND_BOARD_SIZE;
}

function _getCameraWorldPosition(camera) {
    if (
        camera &&
        camera.globalPosition &&
        Number.isFinite(camera.globalPosition.x) &&
        Number.isFinite(camera.globalPosition.y) &&
        Number.isFinite(camera.globalPosition.z)
    ) {
        return camera.globalPosition;
    }

    if (
        camera &&
        camera.position &&
        Number.isFinite(camera.position.x) &&
        Number.isFinite(camera.position.y) &&
        Number.isFinite(camera.position.z)
    ) {
        return camera.position;
    }

    return null;
}

function getSkySphereDiameter(camera, sceneryComplexity) {
    if (!(typeof sceneryComplexity !== "undefined" && sceneryComplexity <= 0)) {
        return DEFAULT_SKY_SPHERE_DIAMETER;
    }

    const boardSize = _getLowDetailGroundBoardSize();
    const halfBoard = boardSize / 2;
    const minDiameter = Math.ceil(boardSize * Math.SQRT2 + LOW_DETAIL_SKY_DIAMETER_MARGIN);
    const cameraPos = _getCameraWorldPosition(camera);

    if (!cameraPos) {
        return Math.max(DEFAULT_SKY_SPHERE_DIAMETER, minDiameter);
    }

    const boardCorners = [
        [-halfBoard, -halfBoard],
        [-halfBoard, halfBoard],
        [halfBoard, -halfBoard],
        [halfBoard, halfBoard],
    ];

    let maxCornerDistance = 0;
    for (const [cornerX, cornerZ] of boardCorners) {
        const dx = cornerX - cameraPos.x;
        const dy = -cameraPos.y;
        const dz = cornerZ - cameraPos.z;
        const cornerDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        maxCornerDistance = Math.max(maxCornerDistance, cornerDistance);
    }

    return Math.max(
        DEFAULT_SKY_SPHERE_DIAMETER,
        minDiameter,
        Math.ceil(2 * maxCornerDistance + LOW_DETAIL_SKY_DIAMETER_MARGIN)
    );
}

function createSkySphere(scene, camera, sceneryComplexity) {
    const skyDiameter = getSkySphereDiameter(camera, sceneryComplexity);

    // Create a sphere (with inverted normals) to serve as the sky dome.
    const skySphere = BABYLON.MeshBuilder.CreateSphere(
        "skySphere",
        {
            diameter: skyDiameter,
            segments: 16, // <--- Added this line. Lower value = fewer triangles.
            sideOrientation: BABYLON.Mesh.BACKSIDE
        },
        scene
    );
    skySphere.metadata = {
        initialDiameter: skyDiameter
    };

    let skyTexture;

    if (typeof game_environment !== 'undefined' && (game_environment === "night" || game_environment === "dusk")) {
        // Night/dusk mode uses the night_sky.jpg asset
        // Support running locally via file:// using the Base64 constant to bypass CORS
        if (window.location.protocol === "file:") {
            skyTexture = new BABYLON.Texture(
                typeof NIGHT_SKY_DOME_B64 !== "undefined" ? NIGHT_SKY_DOME_B64 : null,
                scene
            );
        } else {
            skyTexture = new BABYLON.Texture(
                "./assets/night_sky.jpg",
                scene
            );
        }
        skyTexture.coordinatesMode = BABYLON.Texture.SPHERICAL_MODE;
    } else if (typeof game_environment !== 'undefined' && game_environment === "sunny") {
        // Sunny mode uses the high-res seamless panorama texture
        // Support running locally via file:// using the Base64 constant to bypass CORS.
        if (window.location.protocol === "file:") {
            skyTexture = new BABYLON.Texture(
                typeof DAY_SKY_B64 !== "undefined" ? DAY_SKY_B64 : null,
                scene
            );
        } else {
            skyTexture = new BABYLON.Texture(
                "./assets/day_sky.jpg",
                scene
            );
        }
        skyTexture.coordinatesMode = BABYLON.Texture.SPHERICAL_MODE;
    } else {
        // Fog/Day mode (or fallback): Skip texture loading for performance
        // Return early with a very basic solid color material
        const fogMaterial = new BABYLON.StandardMaterial("fogSkyMaterial", scene);
        fogMaterial.backFaceCulling = false;
        fogMaterial.emissiveColor = new BABYLON.Color3(180 / 255, 206 / 255, 255 / 255); // Match fog color
        fogMaterial.disableLighting = true; // No lights affect this

        skySphere.material = fogMaterial;
        skySphere.isAlwaysActive = true;
        skySphere.isPickable = false;
        skySphere.infiniteDistance = true;
        skySphere.position = BABYLON.Vector3.Zero();
        return skySphere;
    }

    // Create a material that uses the gradient texture.
    const skyMaterial = new BABYLON.StandardMaterial("skyMaterial", scene);
    skyMaterial.backFaceCulling = false;  // Render the inside of the sphere.
    skyMaterial.diffuseTexture = skyTexture;

    // Apply the material to the sky sphere.
    skySphere.material = skyMaterial;

    // Allow scene fog to affect the sky dome, except in sunny mode where we want to clearly see the sky texture!
    if (typeof game_environment !== 'undefined' && game_environment === "sunny") {
        skyMaterial.fogEnabled = false;
    } else {
        skyMaterial.fogEnabled = true;
    }

    // Adjust brightness based on the environment
    if (typeof game_environment !== 'undefined' && game_environment === "night") {
        skyMaterial.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.5); // Much darker sky dome
    } else if (typeof game_environment !== 'undefined' && game_environment === "dusk") {
        skyMaterial.emissiveColor = new BABYLON.Color3(0.7, 0.7, 0.7); // 30% darker sky dome
    } else {
        skyMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1); // Full brightness for daytime
    }
    skySphere.isAlwaysActive = true; // Ensure it renders even if outside the frustum.
    skySphere.isPickable = false; // Not needed for picking
    skySphere.infiniteDistance = true; // Always stays at the far clipping plane natively

    // Align the sky sphere with the camera target if available.
    // **Note:** We will keep the sphere centered at the origin for simpler distance calculations later.
    skySphere.position = BABYLON.Vector3.Zero(); // Keep centered at world origin

    // Optionally rotate the sky sphere to align the sun position or horizon.
    skySphere.rotation.x = 0; // Fixed from Math.PI/2 which was turning the horizon 90 degrees
    skySphere.rotation.y = 0;
    skySphere.rotation.z = Math.PI; // Flip upright if the texture is inverted

    return skySphere;
}


/**
 * Keeps the low-detail sky dome large enough to fully cover the
 * checkered ground footprint from the current camera position.
 * Higher scenery modes keep their original fixed dome size.
 * @param {BABYLON.Scene} scene - The Babylon scene.
 * @param {BABYLON.Camera} camera - The currently active camera.
 */
function updateSkySphereDiameter(scene, camera) {
    if (typeof scenery_complexity === 'undefined' || scenery_complexity > 0) {
        return;
    }

    const skySphere = scene.getMeshByName("skySphere");
    if (
        !skySphere ||
        !skySphere.metadata ||
        !Number.isFinite(skySphere.metadata.initialDiameter) ||
        skySphere.metadata.initialDiameter <= 0
    ) {
        return;
    }

    const desiredDiameter = getSkySphereDiameter(camera, scenery_complexity);
    if (!Number.isFinite(desiredDiameter) || desiredDiameter <= 0) {
        return;
    }

    const desiredScale = desiredDiameter / skySphere.metadata.initialDiameter;
    const currentScale = (skySphere.scaling && Number.isFinite(skySphere.scaling.x))
        ? skySphere.scaling.x
        : 1.0;

    if (!Number.isFinite(desiredScale) || Math.abs(currentScale - desiredScale) < 0.01) {
        return;
    }

    skySphere.scaling.copyFromFloats(desiredScale, desiredScale, desiredScale);
}


function create_fog(scene) {
    // Fog is a "looks like a sim" extra, not a low-spec feature. Turn it
    // on at scenery_complexity >= 2 (same threshold that unlocks buildings
    // and the animated water surface in 4.1_🌍_create_world_scenery.js).
    // The previous guard was `< 4`, which was always true for the
    // documented 0-3 range and silently disabled fog everywhere.
    if (typeof scenery_complexity !== 'undefined' && scenery_complexity < 2) {
        scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
        return;
    }

    if (typeof game_environment !== 'undefined' && game_environment === "night") {
        scene.fogMode = BABYLON.Scene.FOGMODE_NONE; // Disable fog by default in strict night mode
    } else if (typeof game_environment !== 'undefined' && game_environment === "sunny") {
        // Enable a very thin fog for the sunny mode.
        // The massive distance between 1000 and 100,000 means objects at 3,000 units
        // barely have 1% of fog applied to them, making it look incredibly thin.
        scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
        scene.fogStart = 400.0;
        scene.fogEnd = 5000.0; // Pushed VERY far back to make the fog incredibly thin over distance
        scene.fogColor = new BABYLON.Color3(160 / 255, 170 / 255, 200 / 255); // Color matching the sky dome
    } else {
        // Enable linear fog for day mode (fog environment) or dusk mode.
        scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
        scene.fogStart = 300.0; // Start distance of fog effect
        scene.fogEnd = 2800.0; // Full fog effect distance
        scene.fogColor = new BABYLON.Color3(180 / 255, 206 / 255, 255 / 255); // Light blueish fog blending with the sky horizon
    }
}
