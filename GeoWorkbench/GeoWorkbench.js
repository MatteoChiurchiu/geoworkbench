window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "https://cdn.jsdelivr.net/npm/cesium@1.139.0/Build/Cesium/";

import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  CesiumTerrainProvider,
  Cartographic,
  Cesium3DTileset,
  Color,
  createGooglePhotorealistic3DTileset,
  CzmlDataSource,
  defined,
  EllipsoidTerrainProvider,
  EllipsoidGeodesic,
  GeoJsonDataSource,
  GpxDataSource,
  Ion,
  IonResource,
  KmlDataSource,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  Model,
  PolygonHierarchy,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Terrain,
  Transforms,
  Viewer,
  viewerDragDropMixin,
} from "https://cdn.jsdelivr.net/npm/cesium@1.139.0/+esm";

const viewer = new Viewer("cesiumContainer", {
  requestRenderMode: true,
  terrain: Terrain.fromWorldTerrain({
    requestWaterMask: true,
    requestVertexNormals: true,
  }),
  infoBox: true,
  selectionIndicator: true,
});

viewer.extend(viewerDragDropMixin);

const ui = {
  distanceButton: document.getElementById("distanceButton"),
  areaButton: document.getElementById("areaButton"),
  finishButton: document.getElementById("finishButton"),
  clearButton: document.getElementById("clearButton"),
  terrainMode: document.getElementById("terrainMode"),
  terrainValue: document.getElementById("terrainValue"),
  applyTerrainButton: document.getElementById("applyTerrainButton"),
  sourceUrl: document.getElementById("sourceUrl"),
  sourceType: document.getElementById("sourceType"),
  loadUrlButton: document.getElementById("loadUrlButton"),
  localFiles: document.getElementById("localFiles"),
  loadFilesButton: document.getElementById("loadFilesButton"),
  ionToken: document.getElementById("ionToken"),
  connectIonButton: document.getElementById("connectIonButton"),
  refreshIonButton: document.getElementById("refreshIonButton"),
  ionAssets: document.getElementById("ionAssets"),
  loadIonAssetButton: document.getElementById("loadIonAssetButton"),
  ionAssetId: document.getElementById("ionAssetId"),
  loadIonAssetIdButton: document.getElementById("loadIonAssetIdButton"),
  loadGoogleTilesButton: document.getElementById("loadGoogleTilesButton"),
  statusText: document.getElementById("statusText"),
};

const measurement = {
  mode: null,
  cartographicPoints: [],
  pointEntities: [],
  lineEntity: null,
  polygonEntity: null,
  labelEntity: null,
};

const loadedTilesets = [];
const loadedModels = [];
let googleTerrainTileset = null;
const handler = new ScreenSpaceEventHandler(viewer.canvas);
const ionState = {
  token: "",
  assets: [],
};

const ION_TOKEN_STORAGE_KEY = "geoworkbench_ion_token";
const ION_API_ROOT = "https://api.cesium.com/v1";
const GOOGLE_3D_TILES_ION_ASSET_ID = 2275207;
let objLoadersPromise;

function setStatus(message, isError = false) {
  ui.statusText.textContent = message;
  ui.statusText.style.color = isError ? "#ff9f9f" : "#a8f1df";
}

function inferSourceType(source, selectedType) {
  if (selectedType !== "auto") {
    return selectedType;
  }

  const normalized = source.toLowerCase().split("?")[0].split("#")[0];
  if (normalized.endsWith(".czml")) {
    return "czml";
  }
  if (
    normalized.endsWith(".geojson") ||
    normalized.endsWith(".json") ||
    normalized.endsWith(".topojson")
  ) {
    return "geojson";
  }
  if (normalized.endsWith(".kml") || normalized.endsWith(".kmz")) {
    return "kml";
  }
  if (normalized.endsWith(".gpx")) {
    return "gpx";
  }
  if (normalized.endsWith("tileset.json")) {
    return "3dtiles";
  }
  if (normalized.endsWith(".obj")) {
    return "obj";
  }

  return "";
}

function clearMeasurement() {
  measurement.cartographicPoints = [];

  for (const point of measurement.pointEntities) {
    viewer.entities.remove(point);
  }
  measurement.pointEntities = [];

  if (measurement.lineEntity) {
    viewer.entities.remove(measurement.lineEntity);
    measurement.lineEntity = null;
  }

  if (measurement.polygonEntity) {
    viewer.entities.remove(measurement.polygonEntity);
    measurement.polygonEntity = null;
  }

  if (measurement.labelEntity) {
    viewer.entities.remove(measurement.labelEntity);
    measurement.labelEntity = null;
  }
}

function stopMeasurement(message) {
  measurement.mode = null;
  if (message) {
    setStatus(message);
  }
}

function startMeasurement(mode) {
  clearMeasurement();
  measurement.mode = mode;

  if (mode === "distance") {
    setStatus("Misura distanza attiva. Aggiungi almeno due punti.");
    measurement.lineEntity = viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(() => {
          return measurement.cartographicPoints.map((point) =>
            Cartographic.toCartesian(point),
          );
        }, false),
        width: 3,
        material: Color.fromCssColorString("#23a786"),
      },
    });
  } else {
    setStatus("Misura area attiva. Aggiungi almeno tre punti.");
    measurement.polygonEntity = viewer.entities.add({
      polygon: {
        hierarchy: new CallbackProperty(() => {
          const positions = measurement.cartographicPoints.map((point) =>
            Cartographic.toCartesian(point),
          );
          return new PolygonHierarchy(positions);
        }, false),
        material: Color.fromCssColorString("#3dc9a7").withAlpha(0.35),
        outline: true,
        outlineColor: Color.fromCssColorString("#23a786"),
      },
    });
  }
}

function pickCartographic(screenPosition) {
  const ray = viewer.camera.getPickRay(screenPosition);
  if (!defined(ray)) {
    return undefined;
  }

  const globePosition = viewer.scene.globe.pick(ray, viewer.scene);
  if (!defined(globePosition)) {
    return undefined;
  }

  return Cartographic.fromCartesian(globePosition);
}

function addPoint(cartographic) {
  measurement.cartographicPoints.push(cartographic);

  const pointEntity = viewer.entities.add({
    position: Cartographic.toCartesian(cartographic),
    point: {
      pixelSize: 8,
      color: Color.fromCssColorString("#ffd166"),
      outlineColor: Color.BLACK,
      outlineWidth: 2,
    },
  });

  measurement.pointEntities.push(pointEntity);
  updateMeasurementLabel();
}

function computeDistanceMeters(cartographicPoints) {
  let total = 0;
  for (let i = 1; i < cartographicPoints.length; i++) {
    const segment = new EllipsoidGeodesic(
      cartographicPoints[i - 1],
      cartographicPoints[i],
    );
    total += segment.surfaceDistance;
  }
  return total;
}

function computeAreaMeters(cartographicPoints) {
  if (cartographicPoints.length < 3) {
    return 0;
  }

  const center = Cartographic.clone(cartographicPoints[0]);
  for (const point of cartographicPoints) {
    center.longitude += point.longitude;
    center.latitude += point.latitude;
    center.height += point.height;
  }
  center.longitude /= cartographicPoints.length;
  center.latitude /= cartographicPoints.length;
  center.height /= cartographicPoints.length;

  const centerCartesian = Cartographic.toCartesian(center);
  const enu = Transforms.eastNorthUpToFixedFrame(centerCartesian);
  const inverseEnu = Matrix4.inverse(enu, new Matrix4());

  const points2D = cartographicPoints.map((point) => {
    const world = Cartographic.toCartesian(point);
    const local = Matrix4.multiplyByPoint(inverseEnu, world, new Cartesian3());
    return new Cartesian2(local.x, local.y);
  });

  let area = 0;
  for (let i = 0; i < points2D.length; i++) {
    const p1 = points2D[i];
    const p2 = points2D[(i + 1) % points2D.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }

  return Math.abs(area) * 0.5;
}

function updateMeasurementLabel() {
  const points = measurement.cartographicPoints;
  const hasEnoughPoints =
    measurement.mode === "distance" ? points.length >= 2 : points.length >= 3;

  if (!hasEnoughPoints) {
    if (measurement.labelEntity) {
      viewer.entities.remove(measurement.labelEntity);
      measurement.labelEntity = null;
    }
    return;
  }

  const lastPoint = points[points.length - 1];
  const labelPosition = Cartographic.toCartesian(lastPoint);

  let text;
  if (measurement.mode === "distance") {
    const meters = computeDistanceMeters(points);
    const km = meters / 1000;
    text = meters < 1000 ? `${meters.toFixed(1)} m` : `${km.toFixed(3)} km`;
  } else {
    const sqm = computeAreaMeters(points);
    const sqkm = sqm / 1e6;
    text = sqm < 1e6 ? `${sqm.toFixed(0)} m2` : `${sqkm.toFixed(3)} km2`;
  }

  if (!measurement.labelEntity) {
    measurement.labelEntity = viewer.entities.add({
      position: labelPosition,
      label: {
        text,
        font: "15px Segoe UI",
        style: LabelStyle.FILL_AND_OUTLINE,
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        pixelOffset: new Cartesian2(0, -24),
        showBackground: true,
        backgroundColor: Color.fromCssColorString("#1d2d44").withAlpha(0.8),
      },
    });
  } else {
    measurement.labelEntity.position = labelPosition;
    measurement.labelEntity.label.text = text;
  }
}

async function loadDataSource(source, selectedType, nameForStatus) {
  const sourceType = inferSourceType(nameForStatus || source, selectedType);
  if (!sourceType) {
    throw new Error("Formato non riconosciuto. Seleziona il tipo manualmente.");
  }

  if (sourceType === "obj") {
    throw new Error(
      "OBJ via URL non supportato in modo affidabile. Usa il caricamento file locale.",
    );
  }

  if (sourceType === "3dtiles") {
    const tileset = await Cesium3DTileset.fromUrl(source);
    viewer.scene.primitives.add(tileset);
    loadedTilesets.push(tileset);
    await viewer.zoomTo(tileset);
    return;
  }

  let loadPromise;
  if (sourceType === "czml") {
    loadPromise = CzmlDataSource.load(source);
  } else if (sourceType === "geojson") {
    loadPromise = GeoJsonDataSource.load(source);
  } else if (sourceType === "kml") {
    loadPromise = KmlDataSource.load(source, {
      camera: viewer.scene.camera,
      canvas: viewer.scene.canvas,
      screenOverlayContainer: viewer.container,
    });
  } else if (sourceType === "gpx") {
    loadPromise = GpxDataSource.load(source);
  }

  const dataSource = await viewer.dataSources.add(loadPromise);
  await viewer.flyTo(dataSource);

  if (nameForStatus) {
    setStatus(`Caricato: ${nameForStatus}`);
  }
}

async function getObjLoaders() {
  if (!objLoadersPromise) {
    objLoadersPromise = (async () => {
      const THREE = await import(
        "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js"
      );
      const { OBJLoader } = await import(
        "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/loaders/OBJLoader.js"
      );
      const { MTLLoader } = await import(
        "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/loaders/MTLLoader.js"
      );
      const { GLTFExporter } = await import(
        "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/exporters/GLTFExporter.js"
      );

      return { THREE, OBJLoader, MTLLoader, GLTFExporter };
    })();
  }

  return objLoadersPromise;
}

function getPlacementMatrixAtScreenCenter() {
  const scene = viewer.scene;
  const center = new Cartesian2(
    scene.canvas.clientWidth * 0.5,
    scene.canvas.clientHeight * 0.5,
  );
  const ray = viewer.camera.getPickRay(center);

  let worldPosition;
  if (defined(ray)) {
    worldPosition = scene.globe.pick(ray, scene);
  }

  if (!defined(worldPosition)) {
    worldPosition = Cartesian3.clone(viewer.camera.positionWC);
  }

  return Transforms.eastNorthUpToFixedFrame(worldPosition);
}

async function loadObjModelFromFiles(objFile, allFiles) {
  const { THREE, OBJLoader, MTLLoader, GLTFExporter } = await getObjLoaders();
  const fileMap = new Map(allFiles.map((file) => [file.name.toLowerCase(), file]));
  const objText = await objFile.text();

  let materialCreator;
  const mtllibMatch = objText.match(/^mtllib\s+(.+)$/im);
  if (mtllibMatch) {
    const mtlName = mtllibMatch[1].trim().toLowerCase();
    const mtlFile = fileMap.get(mtlName);
    if (mtlFile) {
      const mtlText = await mtlFile.text();
      const mtlLoader = new MTLLoader();
      materialCreator = mtlLoader.parse(mtlText, "");
      materialCreator.preload();
    }
  }

  const objLoader = new OBJLoader();
  if (materialCreator) {
    objLoader.setMaterials(materialCreator);
  }

  const group = objLoader.parse(objText);
  group.traverse((node) => {
    if (node.isMesh && !node.material) {
      node.material = new THREE.MeshStandardMaterial({ color: 0xbdbdbd });
    }
  });

  const exporter = new GLTFExporter();
  const glbData = await new Promise((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Uint8Array(result));
          return;
        }
        reject(new Error("Conversione OBJ fallita: output glTF non binario."));
      },
      (error) => reject(error),
      {
        binary: true,
        onlyVisible: true,
      },
    );
  });

  const model = await Model.fromGltfAsync({
    gltf: glbData,
    modelMatrix: getPlacementMatrixAtScreenCenter(),
    scale: 1.0,
  });

  viewer.scene.primitives.add(model);
  loadedModels.push(model);
  await viewer.zoomTo(model);
}

function getAssetDescription(asset) {
  const type = asset.type || "UNKNOWN";
  const id = asset.id;
  const name = asset.name || `Asset ${id}`;
  return `${name} [${type}] (#${id})`;
}

function refreshIonAssetSelect() {
  ui.ionAssets.innerHTML = "";

  if (ionState.assets.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Nessun asset trovato";
    ui.ionAssets.append(option);
    return;
  }

  for (const asset of ionState.assets) {
    const option = document.createElement("option");
    option.value = String(asset.id);
    option.textContent = getAssetDescription(asset);
    ui.ionAssets.append(option);
  }

  ui.ionAssets.selectedIndex = 0;
}

async function fetchIonAssets() {
  if (!ionState.token) {
    throw new Error("Token Cesium ion mancante.");
  }

  const meResponse = await fetch(`${ION_API_ROOT}/me`, {
    headers: {
      Authorization: `Bearer ${ionState.token}`,
    },
  });

  if (!meResponse.ok) {
    let message = `Errore autenticazione Cesium ion (${meResponse.status}).`;
    try {
      const errorPayload = await meResponse.json();
      if (errorPayload?.message) {
        message = `${message} ${errorPayload.message}`;
      }
    } catch {
      // Ignore JSON parsing failures and keep fallback message.
    }
    throw new Error(message);
  }

  const response = await fetch(`${ION_API_ROOT}/assets`, {
    headers: {
      Authorization: `Bearer ${ionState.token}`,
    },
  });

  if (!response.ok) {
    let message = `Errore API Cesium ion (${response.status}).`;
    try {
      const errorPayload = await response.json();
      if (errorPayload?.message) {
        message = `${message} ${errorPayload.message}`;
      }
    } catch {
      // Ignore JSON parsing failures and keep fallback message.
    }
    if (response.status === 404) {
      message =
        `${message} Questo token potrebbe non avere il permesso di elencare gli asset. ` +
        "Puoi comunque caricare un asset inserendo il suo Asset ID manualmente.";
    }
    throw new Error(message);
  }

  const payload = await response.json();
  ionState.assets = Array.isArray(payload.items) ? payload.items : [];
  refreshIonAssetSelect();
}

function withTokenQuery(url, token) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("access_token")) {
    parsed.searchParams.set("access_token", token);
  }
  return parsed.toString();
}

async function getIonAssetEndpoint(assetId) {
  const endpointUrl = `${ION_API_ROOT}/assets/${assetId}/endpoint?access_token=${encodeURIComponent(
    ionState.token,
  )}`;
  const response = await fetch(endpointUrl);

  if (!response.ok) {
    let message = `Asset #${assetId} non accessibile (${response.status}).`;
    try {
      const errorPayload = await response.json();
      if (errorPayload?.message) {
        message = `${message} ${errorPayload.message}`;
      }
    } catch {
      // Ignore JSON parsing failures and keep fallback message.
    }
    throw new Error(message);
  }

  return response.json();
}

async function loadIonAssetById(assetId) {
  const endpoint = await getIonAssetEndpoint(assetId);
  const endpointAccessToken = endpoint.accessToken || ionState.token;
  const endpointType = (endpoint.type || "").toUpperCase();
  const endpointUrl = withTokenQuery(endpoint.url, endpointAccessToken);

  let ionResource;
  try {
    ionResource = await IonResource.fromAssetId(assetId, {
      accessToken: ionState.token,
    });
  } catch {
    ionResource = undefined;
  }

  if (endpointType === "3DTILES") {
    const tileset = await Cesium3DTileset.fromUrl(ionResource || endpointUrl);
    viewer.scene.primitives.add(tileset);
    loadedTilesets.push(tileset);
    await viewer.zoomTo(tileset);
    return;
  }

  if (endpointType === "TERRAIN") {
    viewer.terrainProvider = await CesiumTerrainProvider.fromUrl(
      ionResource || endpointUrl,
    );
    setStatus(`Terrain ion #${assetId} attivo.`);
    return;
  }

  if (endpointType === "CZML") {
    const dataSource = await viewer.dataSources.add(
      CzmlDataSource.load(ionResource || endpointUrl),
    );
    await viewer.flyTo(dataSource);
    return;
  }

  if (endpointType === "KML") {
    const dataSource = await viewer.dataSources.add(
      KmlDataSource.load(ionResource || endpointUrl, {
        camera: viewer.scene.camera,
        canvas: viewer.scene.canvas,
        screenOverlayContainer: viewer.container,
      }),
    );
    await viewer.flyTo(dataSource);
    return;
  }

  if (endpointType === "GEOJSON") {
    const dataSource = await viewer.dataSources.add(
      GeoJsonDataSource.load(ionResource || endpointUrl),
    );
    await viewer.flyTo(dataSource);
    return;
  }

  throw new Error(
    `Tipo asset non ancora supportato: ${endpointType || "UNKNOWN"}.`,
  );
}

async function loadGooglePhotorealisticTiles() {
  if (!ionState.token) {
    throw new Error("Inserisci prima un token Cesium ion valido.");
  }

  try {
    const googleTiles = await createGooglePhotorealistic3DTileset();
    viewer.scene.primitives.add(googleTiles);
    loadedTilesets.push(googleTiles);
    await viewer.zoomTo(googleTiles);
    return;
  } catch {
    // Fallback for environments where helper API is unavailable.
  }

  await loadIonAssetById(GOOGLE_3D_TILES_ION_ASSET_ID);
}

function removeGoogleTerrainTileset() {
  if (!googleTerrainTileset) {
    return;
  }

  viewer.scene.primitives.remove(googleTerrainTileset);
  const index = loadedTilesets.indexOf(googleTerrainTileset);
  if (index >= 0) {
    loadedTilesets.splice(index, 1);
  }
  googleTerrainTileset.destroy();
  googleTerrainTileset = null;
}

async function ensureGoogleTerrainTileset() {
  if (googleTerrainTileset) {
    return googleTerrainTileset;
  }

  try {
    googleTerrainTileset = await createGooglePhotorealistic3DTileset();
  } catch {
    const endpoint = await getIonAssetEndpoint(GOOGLE_3D_TILES_ION_ASSET_ID);
    const endpointAccessToken = endpoint.accessToken || ionState.token;
    const endpointUrl = withTokenQuery(endpoint.url, endpointAccessToken);

    let ionResource;
    try {
      ionResource = await IonResource.fromAssetId(GOOGLE_3D_TILES_ION_ASSET_ID, {
        accessToken: ionState.token,
      });
    } catch {
      ionResource = undefined;
    }

    googleTerrainTileset = await Cesium3DTileset.fromUrl(ionResource || endpointUrl);
  }

  viewer.scene.primitives.add(googleTerrainTileset);
  loadedTilesets.push(googleTerrainTileset);
  return googleTerrainTileset;
}

async function applyTerrainModel() {
  const mode = ui.terrainMode.value;
  const value = ui.terrainValue.value.trim();

  if (mode !== "google") {
    removeGoogleTerrainTileset();
  }

  if (mode === "ellipsoid") {
    viewer.terrainProvider = new EllipsoidTerrainProvider();
    setStatus("Terreno attivo: WGS84 ellissoide.");
    return;
  }

  if (mode === "world") {
    viewer.scene.setTerrain(
      Terrain.fromWorldTerrain({
        requestWaterMask: true,
        requestVertexNormals: true,
      }),
    );
    setStatus("Terreno attivo: Cesium World Terrain.");
    return;
  }

  if (mode === "google") {
    if (!ionState.token) {
      throw new Error("Inserisci prima un token Cesium ion valido.");
    }

    viewer.terrainProvider = new EllipsoidTerrainProvider();
    const tileset = await ensureGoogleTerrainTileset();
    await viewer.zoomTo(tileset);
    setStatus("Terreno attivo: Google Photorealistic 3D Tiles (mesh).");
    return;
  }

  if (mode === "ionTerrain") {
    const assetId = Number.parseInt(value, 10);
    if (!Number.isFinite(assetId)) {
      throw new Error("Inserisci un Asset ID ion numerico per il terreno.");
    }

    const endpoint = await getIonAssetEndpoint(assetId);
    const endpointType = (endpoint.type || "").toUpperCase();
    if (endpointType !== "TERRAIN") {
      throw new Error(`Asset #${assetId} non e di tipo TERRAIN.`);
    }

    const endpointAccessToken = endpoint.accessToken || ionState.token;
    const endpointUrl = withTokenQuery(endpoint.url, endpointAccessToken);

    let ionResource;
    try {
      ionResource = await IonResource.fromAssetId(assetId, {
        accessToken: ionState.token,
      });
    } catch {
      ionResource = undefined;
    }

    viewer.terrainProvider = await CesiumTerrainProvider.fromUrl(
      ionResource || endpointUrl,
    );
    setStatus(`Terreno attivo: Asset ion #${assetId}.`);
    return;
  }

  if (mode === "terrainUrl") {
    if (!value) {
      throw new Error("Inserisci un URL di servizio terrain valido.");
    }

    viewer.terrainProvider = await CesiumTerrainProvider.fromUrl(value);
    setStatus("Terreno attivo da URL personalizzato.");
    return;
  }
}

function updateTerrainPlaceholder() {
  const mode = ui.terrainMode.value;
  if (mode === "ionTerrain") {
    ui.terrainValue.placeholder = "Inserisci Asset ID terrain Cesium ion";
    return;
  }
  if (mode === "terrainUrl") {
    ui.terrainValue.placeholder =
      "Inserisci URL terrain (es. quantized-mesh endpoint TINItaly/NASA)";
    return;
  }
  ui.terrainValue.placeholder = "Non richiesto per questa modalita";
}

handler.setInputAction((click) => {
  if (!measurement.mode) {
    return;
  }

  const cartographic = pickCartographic(click.position);
  if (!defined(cartographic)) {
    setStatus("Nessun punto valido trovato in questa posizione.", true);
    return;
  }

  addPoint(cartographic);
}, ScreenSpaceEventType.LEFT_CLICK);

handler.setInputAction(() => {
  if (!measurement.mode) {
    return;
  }

  const pointCount = measurement.cartographicPoints.length;
  if (measurement.mode === "distance" && pointCount < 2) {
    setStatus("Aggiungi almeno due punti prima di chiudere la misura.", true);
    return;
  }
  if (measurement.mode === "area" && pointCount < 3) {
    setStatus("Aggiungi almeno tre punti prima di chiudere la misura.", true);
    return;
  }

  stopMeasurement("Misura chiusa.");
}, ScreenSpaceEventType.RIGHT_CLICK);

ui.distanceButton.addEventListener("click", () => {
  startMeasurement("distance");
});

ui.areaButton.addEventListener("click", () => {
  startMeasurement("area");
});

ui.finishButton.addEventListener("click", () => {
  if (!measurement.mode) {
    setStatus("Nessuna misura attiva.");
    return;
  }
  stopMeasurement("Misura chiusa.");
});

ui.clearButton.addEventListener("click", async () => {
  clearMeasurement();
  stopMeasurement("Pulizia completata.");

  for (let i = viewer.dataSources.length - 1; i >= 0; i--) {
    const dataSource = viewer.dataSources.get(i);
    await viewer.dataSources.remove(dataSource, true);
  }

  for (const tileset of loadedTilesets) {
    viewer.scene.primitives.remove(tileset);
    tileset.destroy();
  }
  loadedTilesets.length = 0;

  for (const model of loadedModels) {
    viewer.scene.primitives.remove(model);
    model.destroy();
  }
  loadedModels.length = 0;

  removeGoogleTerrainTileset();
});

ui.applyTerrainButton.addEventListener("click", async () => {
  try {
    setStatus("Applicazione modello terreno...");
    await applyTerrainModel();
  } catch (error) {
    setStatus(`Errore terreno: ${error.message}`, true);
  }
});

ui.terrainMode.addEventListener("change", () => {
  updateTerrainPlaceholder();
});

ui.loadUrlButton.addEventListener("click", async () => {
  const url = ui.sourceUrl.value.trim();
  if (!url) {
    setStatus("Inserisci un URL valido.", true);
    return;
  }

  try {
    setStatus("Caricamento da URL in corso...");
    await loadDataSource(url, ui.sourceType.value, url);
    setStatus(`Caricato da URL: ${url}`);
  } catch (error) {
    setStatus(`Errore caricamento URL: ${error.message}`, true);
  }
});

ui.loadFilesButton.addEventListener("click", async () => {
  const files = [...ui.localFiles.files];
  if (files.length === 0) {
    setStatus("Seleziona almeno un file.", true);
    return;
  }

  const selectedType = ui.sourceType.value;
  const objFiles = files.filter((file) => file.name.toLowerCase().endsWith(".obj"));
  const shouldProcessObj =
    selectedType === "obj" || (selectedType === "auto" && objFiles.length > 0);

  if (shouldProcessObj) {
    if (objFiles.length === 0) {
      setStatus("Nessun file .obj trovato nella selezione.", true);
      return;
    }

    for (const objFile of objFiles) {
      try {
        setStatus(`Caricamento OBJ ${objFile.name}...`);
        await loadObjModelFromFiles(objFile, files);
        setStatus(`OBJ caricato: ${objFile.name}`);
      } catch (error) {
        setStatus(`Errore su ${objFile.name}: ${error.message}`, true);
      }
    }
    return;
  }

  for (const file of files) {
    const objectUrl = URL.createObjectURL(file);
    try {
      setStatus(`Caricamento file ${file.name}...`);
      await loadDataSource(objectUrl, ui.sourceType.value, file.name);
    } catch (error) {
      setStatus(`Errore su ${file.name}: ${error.message}`, true);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
});

ui.connectIonButton.addEventListener("click", async () => {
  const token = ui.ionToken.value.trim();
  if (!token) {
    setStatus("Inserisci un token Cesium ion.", true);
    return;
  }

  ionState.token = token;
  Ion.defaultAccessToken = token;
  localStorage.setItem(ION_TOKEN_STORAGE_KEY, token);

  try {
    setStatus("Connessione a Cesium ion in corso...");
    await fetchIonAssets();
    setStatus(`Connesso. Asset trovati: ${ionState.assets.length}`);
  } catch (error) {
    if (String(error.message).includes("(404)")) {
      setStatus(
        "Token valido ma lista asset non disponibile. Usa Asset ID manuale oppure crea un token con permesso list assets.",
        true,
      );
    } else {
      setStatus(
        `Errore connessione Cesium ion: ${error.message} Verifica anche Allowed URLs del token.`,
        true,
      );
    }
  }
});

ui.refreshIonButton.addEventListener("click", async () => {
  try {
    setStatus("Aggiornamento lista asset ion...");
    await fetchIonAssets();
    setStatus(`Lista aggiornata. Asset: ${ionState.assets.length}`);
  } catch (error) {
    setStatus(`Errore aggiornamento lista: ${error.message}`, true);
  }
});

ui.loadIonAssetButton.addEventListener("click", async () => {
  const selected = ui.ionAssets.value;
  const assetId = Number.parseInt(selected, 10);
  if (!Number.isFinite(assetId)) {
    setStatus("Seleziona un asset valido.", true);
    return;
  }

  try {
    setStatus(`Caricamento asset ion #${assetId}...`);
    await loadIonAssetById(assetId);
    setStatus(`Asset ion #${assetId} caricato.`);
  } catch (error) {
    setStatus(`Errore caricamento asset ion: ${error.message}`, true);
  }
});

ui.loadIonAssetIdButton.addEventListener("click", async () => {
  const rawValue = ui.ionAssetId.value.trim();
  const assetId = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(assetId)) {
    setStatus("Inserisci un Asset ID numerico valido.", true);
    return;
  }

  try {
    setStatus(`Caricamento asset ion #${assetId}...`);
    await loadIonAssetById(assetId);
    setStatus(`Asset ion #${assetId} caricato.`);
  } catch (error) {
    setStatus(`Errore caricamento asset ion: ${error.message}`, true);
  }
});

ui.loadGoogleTilesButton.addEventListener("click", async () => {
  try {
    setStatus("Caricamento Google 3D Tiles in corso...");
    ui.terrainMode.value = "google";
    await applyTerrainModel();
    setStatus("Google 3D Tiles caricato.");
  } catch (error) {
    setStatus(
      `Errore Google 3D Tiles: ${error.message} Controlla permessi token e Allowed URLs.`,
      true,
    );
  }
});

const savedIonToken = localStorage.getItem(ION_TOKEN_STORAGE_KEY);
if (savedIonToken) {
  ui.ionToken.value = savedIonToken;
  ionState.token = savedIonToken;
  Ion.defaultAccessToken = savedIonToken;
}

refreshIonAssetSelect();
updateTerrainPlaceholder();

setStatus("Viewer pronto. Scegli uno strumento o carica dati.");
