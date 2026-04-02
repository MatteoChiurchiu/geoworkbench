window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "https://cdn.jsdelivr.net/npm/cesium@1.139.0/Build/Cesium/";

import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  Color,
  CzmlDataSource,
  defined,
  EllipsoidGeodesic,
  GeoJsonDataSource,
  GpxDataSource,
  Ion,
  IonResource,
  KmlDataSource,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
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
const handler = new ScreenSpaceEventHandler(viewer.canvas);
const ionState = {
  token: "",
  assets: [],
};

const ION_TOKEN_STORAGE_KEY = "geoworkbench_ion_token";

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

  const meResponse = await fetch("https://api.cesium.com/v1/me", {
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

  const response = await fetch("https://api.cesium.com/v1/assets", {
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

async function loadIonAssetById(assetId) {
  const listedAsset = ionState.assets.find((item) => item.id === assetId);
  let assetMeta = listedAsset;

  if (!assetMeta) {
    const response = await fetch(`https://api.cesium.com/v1/assets/${assetId}`, {
      headers: {
        Authorization: `Bearer ${ionState.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Asset #${assetId} non accessibile (${response.status}).`);
    }

    assetMeta = await response.json();
  }

  const resource = await IonResource.fromAssetId(assetId);
  const type = (assetMeta.type || "").toUpperCase();

  if (type === "3DTILES" || type === "TERRAIN") {
    const tileset = await Cesium3DTileset.fromUrl(resource);
    viewer.scene.primitives.add(tileset);
    loadedTilesets.push(tileset);
    await viewer.zoomTo(tileset);
    return;
  }

  if (type === "CZML") {
    const dataSource = await viewer.dataSources.add(CzmlDataSource.load(resource));
    await viewer.flyTo(dataSource);
    return;
  }

  if (type === "KML") {
    const dataSource = await viewer.dataSources.add(
      KmlDataSource.load(resource, {
        camera: viewer.scene.camera,
        canvas: viewer.scene.canvas,
        screenOverlayContainer: viewer.container,
      }),
    );
    await viewer.flyTo(dataSource);
    return;
  }

  if (type === "GEOJSON") {
    const dataSource = await viewer.dataSources.add(GeoJsonDataSource.load(resource));
    await viewer.flyTo(dataSource);
    return;
  }

  throw new Error(`Tipo asset non ancora supportato: ${type || "UNKNOWN"}`);
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
      setStatus(`Errore connessione Cesium ion: ${error.message}`, true);
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

const savedIonToken = localStorage.getItem(ION_TOKEN_STORAGE_KEY);
if (savedIonToken) {
  ui.ionToken.value = savedIonToken;
  ionState.token = savedIonToken;
  Ion.defaultAccessToken = savedIonToken;
}

refreshIonAssetSelect();

setStatus("Viewer pronto. Scegli uno strumento o carica dati.");
