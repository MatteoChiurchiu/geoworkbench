window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

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
  WebMapServiceImageryProvider,
  viewerDragDropMixin,
} from "../../Build/CesiumUnminified/index.js";

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
  menuPanel: document.getElementById("menuPanel"),
  panelCollapseButton: document.getElementById("panelCollapseButton"),
  distanceButton: document.getElementById("distanceButton"),
  areaButton: document.getElementById("areaButton"),
  finishButton: document.getElementById("finishButton"),
  clearButton: document.getElementById("clearButton"),
  terrainMode: document.getElementById("terrainMode"),
  applyTerrainButton: document.getElementById("applyTerrainButton"),
  sourceUrl: document.getElementById("sourceUrl"),
  urlSourceType: document.getElementById("urlSourceType"),
  wmsLayers: document.getElementById("wmsLayers"),
  sourceType: document.getElementById("sourceType"),
  loadUrlButton: document.getElementById("loadUrlButton"),
  localFiles: document.getElementById("localFiles"),
  loadFilesButton: document.getElementById("loadFilesButton"),
  ionToken: document.getElementById("ionToken"),
  connectIonButton: document.getElementById("connectIonButton"),
  refreshIonButton: document.getElementById("refreshIonButton"),
  ionAssets: document.getElementById("ionAssets"),
  loadIonAssetButton: document.getElementById("loadIonAssetButton"),
  loadedLayers: document.getElementById("loadedLayers"),
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
const loadedImageryLayers = [];
const loadedLayerEntries = [];
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

function renderLoadedLayers() {
  ui.loadedLayers.innerHTML = "";

  if (loadedLayerEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "layerListEmpty";
    empty.textContent = "Nessun layer caricato.";
    ui.loadedLayers.append(empty);
    return;
  }

  for (const entry of loadedLayerEntries) {
    const row = document.createElement("label");
    row.className = "layerItem";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = entry.getVisible();
    checkbox.addEventListener("change", () => {
      entry.setVisible(checkbox.checked);
      viewer.scene.requestRender();
    });

    const text = document.createElement("span");
    text.textContent = entry.label;

    row.append(checkbox, text);
    ui.loadedLayers.append(row);
  }
}

function registerLoadedLayer(label, object, getVisible, setVisible) {
  loadedLayerEntries.push({
    label,
    object,
    getVisible,
    setVisible,
  });
  renderLoadedLayers();
}

function resetLoadedLayerList() {
  loadedLayerEntries.length = 0;
  renderLoadedLayers();
}

function inferLocalSourceType(source, selectedType) {
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

async function loadDataByType(source, sourceType, nameForStatus) {
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
    tileset.show = true;
    viewer.scene.primitives.add(tileset);
    loadedTilesets.push(tileset);
    registerLoadedLayer(
      `3D Tiles: ${nameForStatus || source}`,
      tileset,
      () => tileset.show,
      (visible) => {
        tileset.show = visible;
      },
    );
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
  dataSource.show = true;
  registerLoadedLayer(
    `Data: ${nameForStatus || source}`,
    dataSource,
    () => dataSource.show,
    (visible) => {
      dataSource.show = visible;
    },
  );
  await viewer.flyTo(dataSource);

  if (nameForStatus) {
    setStatus(`Caricato: ${nameForStatus}`);
  }
}

async function loadLocalDataSource(source, selectedType, fileName) {
  const sourceType = inferLocalSourceType(fileName || source, selectedType);
  await loadDataByType(source, sourceType, fileName);
}

async function loadUrlSource(url, urlSourceType, wmsLayersInput) {
  if (urlSourceType === "wms") {
    const parsed = new URL(url);
    const layerFromUrl = parsed.searchParams.get("layers") || parsed.searchParams.get("LAYERS");
    const layers = wmsLayersInput || layerFromUrl;

    if (!layers) {
      throw new Error("Per WMS specifica almeno un layer nel campo Layer WMS o nell'URL.");
    }

    const baseUrl = `${parsed.origin}${parsed.pathname}`;
    const parameters = {
      transparent: true,
      format: "image/png",
    };

    for (const [key, value] of parsed.searchParams.entries()) {
      const normalized = key.toLowerCase();
      if (normalized === "service" || normalized === "request" || normalized === "layers") {
        continue;
      }
      parameters[key] = value;
    }

    const layer = viewer.imageryLayers.addImageryProvider(
      new WebMapServiceImageryProvider({
        url: baseUrl,
        layers,
        parameters,
      }),
    );
    layer.show = true;

    loadedImageryLayers.push(layer);
    registerLoadedLayer(
      `WMS: ${layers}`,
      layer,
      () => layer.show,
      (visible) => {
        layer.show = visible;
      },
    );
    setStatus(`Layer WMS caricato: ${layers}`);
    return;
  }

  if (urlSourceType === "api") {
    const dataSource = await viewer.dataSources.add(GeoJsonDataSource.load(url));
    dataSource.show = true;
    registerLoadedLayer(
      `API: ${url}`,
      dataSource,
      () => dataSource.show,
      (visible) => {
        dataSource.show = visible;
      },
    );
    await viewer.flyTo(dataSource);
    return;
  }

  await loadDataByType(url, urlSourceType, url);
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
  registerLoadedLayer(
    `OBJ: ${objFile.name}`,
    model,
    () => model.show,
    (visible) => {
      model.show = visible;
    },
  );
  await viewer.zoomTo(model);
}

function isGooglePhotorealisticAsset(assetId, endpoint) {
  if (assetId === GOOGLE_3D_TILES_ION_ASSET_ID) {
    return true;
  }

  const endpointSignature = `${endpoint.type || ""} ${endpoint.externalType || ""} ${
    endpoint.url || ""
  }`.toLowerCase();
  return endpointSignature.includes("google") && endpointSignature.includes("3d");
}

function getAssetLabel(assetId) {
  const found = ionState.assets.find((asset) => asset.id === assetId);
  if (found) {
    return getAssetDescription(found);
  }
  return `Asset #${assetId}`;
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
      message = `${message} Questo token potrebbe non avere il permesso di elencare gli asset.`;
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
  const assetLabel = getAssetLabel(assetId);

  // For ion-native assets, IonResource handles token refresh and redirects.
  let ionResource;
  try {
    ionResource = await IonResource.fromAssetId(assetId, {
      accessToken: ionState.token,
    });
  } catch {
    ionResource = undefined;
  }

  if (endpointType === "3DTILES") {
    let tileset;
    if (isGooglePhotorealisticAsset(assetId, endpoint)) {
      try {
        tileset = await createGooglePhotorealistic3DTileset();
      } catch {
        tileset = await Cesium3DTileset.fromUrl(ionResource || endpointUrl);
      }
    } else {
      tileset = await Cesium3DTileset.fromUrl(ionResource || endpointUrl);
    }

    tileset.show = true;
    viewer.scene.primitives.add(tileset);
    loadedTilesets.push(tileset);
    registerLoadedLayer(
      `ion 3D Tiles: ${assetLabel}`,
      tileset,
      () => tileset.show,
      (visible) => {
        tileset.show = visible;
      },
    );
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
    dataSource.show = true;
    registerLoadedLayer(
      `ion CZML: ${assetLabel}`,
      dataSource,
      () => dataSource.show,
      (visible) => {
        dataSource.show = visible;
      },
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
    dataSource.show = true;
    registerLoadedLayer(
      `ion KML: ${assetLabel}`,
      dataSource,
      () => dataSource.show,
      (visible) => {
        dataSource.show = visible;
      },
    );
    await viewer.flyTo(dataSource);
    return;
  }

  if (endpointType === "GEOJSON") {
    const dataSource = await viewer.dataSources.add(
      GeoJsonDataSource.load(ionResource || endpointUrl),
    );
    dataSource.show = true;
    registerLoadedLayer(
      `ion GeoJSON: ${assetLabel}`,
      dataSource,
      () => dataSource.show,
      (visible) => {
        dataSource.show = visible;
      },
    );
    await viewer.flyTo(dataSource);
    return;
  }

  throw new Error(
    `Tipo asset non ancora supportato: ${endpointType || "UNKNOWN"}.`,
  );
}

async function applyTerrainModel() {
  const mode = ui.terrainMode.value;

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

  for (const layer of loadedImageryLayers) {
    viewer.imageryLayers.remove(layer, true);
  }
  loadedImageryLayers.length = 0;

  resetLoadedLayerList();
});

ui.applyTerrainButton.addEventListener("click", async () => {
  try {
    setStatus("Applicazione modello terreno...");
    await applyTerrainModel();
  } catch (error) {
    setStatus(`Errore terreno: ${error.message}`, true);
  }
});

ui.loadUrlButton.addEventListener("click", async () => {
  const url = ui.sourceUrl.value.trim();
  const urlType = ui.urlSourceType.value;
  const wmsLayers = ui.wmsLayers.value.trim();
  if (!url) {
    setStatus("Inserisci un URL valido.", true);
    return;
  }

  try {
    setStatus("Caricamento URL/API in corso...");
    await loadUrlSource(url, urlType, wmsLayers);
    setStatus(`Caricato da URL/API: ${url}`);
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
      await loadLocalDataSource(objectUrl, ui.sourceType.value, file.name);
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
        "Token valido ma lista asset non disponibile. Crea un token con permesso list assets.",
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

ui.panelCollapseButton.addEventListener("click", () => {
  const isCollapsed = ui.menuPanel.classList.toggle("is-collapsed");
  ui.panelCollapseButton.textContent = isCollapsed ? "Mostra menu" : "Nascondi menu";
  ui.panelCollapseButton.setAttribute("aria-expanded", String(!isCollapsed));
});

const savedIonToken = localStorage.getItem(ION_TOKEN_STORAGE_KEY);
if (savedIonToken) {
  ui.ionToken.value = savedIonToken;
  ionState.token = savedIonToken;
  Ion.defaultAccessToken = savedIonToken;
}

refreshIonAssetSelect();
renderLoadedLayers();

setStatus("Viewer pronto. Scegli uno strumento o carica dati.");
