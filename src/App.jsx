import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleHelp, Gauge, Info, Map as MapIcon, Play, RotateCcw, Timer, X, Zap } from "lucide-react";

import esriConfig from "@arcgis/core/config.js";
import Map from "@arcgis/core/Map.js";
import MapView from "@arcgis/core/views/MapView.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import ParquetLayer from "@arcgis/core/layers/ParquetLayer.js";
import ParquetPortalItemData from "@arcgis/core/layers/support/ParquetPortalItemData.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import "./App.css";

const PORTAL_URL = "https://www.arcgis.com";
const PARQUET_INFO_URL =
  "https://www.esri.com/arcgis-blog/products/arcgis-online/announcements/scaling-your-gis-workflows-with-the-new-parquet-feature-layer-beta-in-arcgis-online";
const LOAD_TIMEOUT_MS = 120000;

// Stage metadata only.
// The actual zoom levels are configured separately for each dataset below.
const STAGE_DEFINITIONS = [
  { id: "deutschland", label: "Übersicht", detail: "Erstes Laden" },
  { id: "regional", label: "Region", detail: "Neu zeichnen" },
  { id: "lokal", label: "Lokal", detail: "Neu zeichnen" },
];

const DATASETS = {
  haltestellen: {
    label: "Haltestellen",
    description: "Haltestellen in Deutschland",
    geometryType: "point",
    totalFeatures: 719525,

    // Dataset-specific map configuration.
    // ArcGIS uses [longitude, latitude].
    mapCenter: [10.4, 51.1],

    // One zoom level per benchmark stage:
    // Übersicht -> Region -> Lokal
    zoomLevels: [5, 7, 9],

    parquetItemId: "f110c8c9a2ef47e096ed6b1b5ca21f00",
    featureLayerItemId: "b0f19ce050d74cf0a5f6d5937b4efa0d",
  },

  radwege: {
    label: "Flurstücke",
    description: "Flurstücke Schleswig-Holstein",
    geometryType: "polygone",
    totalFeatures: 1964902,

    // Example configuration for Schleswig-Holstein.
    // Adjust these independently from the other dataset.
    mapCenter: [9.8, 54.2],
    zoomLevels: [7, 9, 11],

    parquetItemId: "794e96948594432085edec24a68e8bc6",
    featureLayerUrl:
      "https://services2.arcgis.com/jUpNdisbWqRpMo35/arcgis/rest/services/flstk_Schleswig_Holstein/FeatureServer/1",
  },
};

const DEFAULT_DATASET_ID = "haltestellen";

const numberFormatter = new Intl.NumberFormat("de-DE");
const secondsFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatSeconds = (milliseconds) =>
  milliseconds == null
    ? "–"
    : secondsFormatter.format(milliseconds / 1000);

// Combine generic stage descriptions with the dataset-specific zoom levels.
const getStages = (dataset) =>
  STAGE_DEFINITIONS.map((stage, index) => ({
    ...stage,
    zoom: dataset.zoomLevels[index],
  }));

function waitForFrames(count = 2) {
  return new Promise((resolve) => {
    const next = () =>
      count-- <= 0 ? resolve() : requestAnimationFrame(next);

    next();
  });
}

function withTimeout(promise, message) {
  let timeoutId;

  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error(message)),
      LOAD_TIMEOUT_MS,
    );
  });

  return Promise.race([promise, timeout]).finally(() =>
    window.clearTimeout(timeoutId),
  );
}

const waitForLayerView = (view, layerView) =>
  reactiveUtils.whenOnce(
    () => view.stationary && !layerView.updating && !layerView.suspended,
  );

function formatError(error) {
  return (
    [
      error?.name,
      error?.message,
      ...(error?.details?.messages ?? []),
    ]
      .filter(Boolean)
      .join(": ") || "Unbekannter Fehler bei der ArcGIS-Analyse."
  );
}

function createRenderer(geometryType, color) {
  if (geometryType === "polyline") {
    return {
      type: "simple",
      symbol: {
        type: "simple-line",
        color,
        width: 1.4,
      },
    };
  }

  if (geometryType === "polygon") {
    return {
      type: "simple",
      symbol: {
        type: "simple-fill",
        color: [...color.slice(0, 3), 0.4],
        outline: {
          color,
          width: 0.5,
        },
      },
    };
  }

  return {
    type: "simple",
    symbol: {
      type: "simple-marker",
      style: "circle",
      color,
      size: 3,
      outline: {
        color: [255, 255, 255, 0.3],
        width: 0.25,
      },
    },
  };
}

function winnerFor(result) {
  if (!result) return null;
  if (result.featureTimedOut && result.parquetTimedOut) return "none";
  if (result.featureTimedOut) return "parquet";
  if (result.parquetTimedOut) return "feature";
  if (result.featureMs === result.parquetMs) return "tie";

  return result.featureMs < result.parquetMs ? "feature" : "parquet";
}

const resultFrom = (stage, feature, parquet) => ({
  ...stage,
  featureMs: feature.duration,
  parquetMs: parquet.duration,
  featureTimedOut: feature.timedOut,
  parquetTimedOut: parquet.timedOut,
  differenceMs: Math.abs(feature.duration - parquet.duration),
});

const emptyTimer = () => ({
  milliseconds: 0,
  running: false,
  finished: false,
  timedOut: false,
  status: "Bereit",
});

function InfoModal({ onClose }) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="info-title"
      onMouseDown={(event) =>
        event.target === event.currentTarget && onClose()
      }
    >
      <div className="modal-card">
        <button
          className="icon-button modal-close"
          onClick={onClose}
          aria-label="Fenster schließen"
        >
          <X size={18} />
        </button>

        <span className="eyebrow">
          <Zap size={14} /> Neuer Layer-Typ
        </span>

        <h2 id="info-title">Was ist ein Parquet Feature Layer?</h2>

        <p>
          Ein schreibgeschützter ArcGIS Layer für die schnelle Visualisierung
          sehr großer Geodatensätze. Dieser Benchmark lädt identische Daten in
          beiden Formaten und misst, wann die Karte fertig gezeichnet ist.
        </p>

        <div className="modal-facts">
          <span>
            <Gauge size={18} />
            <strong>Optimiert</strong> für große Datenmengen
          </span>

          <span>
            <MapIcon size={18} />
            <strong>Vergleichbar</strong> in drei Maßstäben
          </span>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            Benchmark ansehen
          </button>

          <a
            className="primary-link"
            href={PARQUET_INFO_URL}
            target="_blank"
            rel="noreferrer"
          >
            Mehr erfahren <ArrowUpRight size={16} />
          </a>
        </div>
      </div>
    </div>
  );
}

function MapPanel({ type, dataset, zoom, timer, containerRef }) {
  const isParquet = type === "parquet";

  return (
    <article className={`map-panel ${isParquet ? "parquet" : "feature"}`}>
      <div className="map-heading">
        <span className="layer-dot" />

        <div>
          <strong>{isParquet ? "GeoParquet" : "Feature Layer"}</strong>
          <small>
            {dataset.label} · Zoom {zoom}
          </small>
        </div>
      </div>

      <div ref={containerRef} className="map-canvas" />

      <div
        className={`map-timer ${timer.running ? "is-running" : ""} ${
          timer.timedOut ? "is-error" : ""
        }`}
      >
        <span>
          <Timer size={14} /> {timer.status}
        </span>

        <strong>
          {timer.timedOut ? "> 30,00" : formatSeconds(timer.milliseconds)}{" "}
          <small>s</small>
        </strong>
      </div>
    </article>
  );
}

function StageResult({ stage, result, active }) {
  const winner = winnerFor(result);

  return (
    <article
      className={`stage-card ${active ? "is-active" : ""} ${
        result ? "is-complete" : ""
      }`}
    >
      <div className="stage-title">
        <span>{result ? <Check size={13} /> : stage.zoom}</span>

        <div>
          <strong>{stage.label}</strong>
          <small>
            Zoom {stage.zoom} · {stage.detail}
          </small>
        </div>
      </div>

      {!result ? (
        <p className="stage-empty">
          {active ? "Wird gerade gemessen …" : "Wartet auf Start"}
        </p>
      ) : (
        <>
          <div className="result-row">
            <span className={winner === "feature" ? "winner" : ""}>
              <i className="feature-color" />
              Feature
              <strong>
                {result.featureTimedOut
                  ? "> 30,00"
                  : formatSeconds(result.featureMs)}{" "}
                s
              </strong>
            </span>

            <span className={winner === "parquet" ? "winner" : ""}>
              <i className="parquet-color" />
              GeoParquet
              <strong>
                {result.parquetTimedOut
                  ? "> 30,00"
                  : formatSeconds(result.parquetMs)}{" "}
                s
              </strong>
            </span>
          </div>

          <p className="result-summary">
            {winner === "none" ? (
              "Beide Zeitlimits erreicht"
            ) : winner === "tie" ? (
              "Gleichstand"
            ) : (
              <>
                <b>
                  {winner === "parquet" ? "GeoParquet" : "Feature Layer"}
                </b>{" "}
                ist {formatSeconds(result.differenceMs)} s schneller
              </>
            )}
          </p>
        </>
      )}
    </article>
  );
}

export default function App() {
  const featureContainerRef = useRef(null);
  const parquetContainerRef = useRef(null);
  const runtimeRef = useRef(null);
  const syncLockRef = useRef(false);
  const syncPausedRef = useRef(false);
  const syncTimeoutRef = useRef(null);
  const timerIntervalsRef = useRef({
    feature: null,
    parquet: null,
  });

  const initialDataset = DATASETS[DEFAULT_DATASET_ID];

  const [selectedDatasetId, setSelectedDatasetId] =
    useState(DEFAULT_DATASET_ID);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Karten werden vorbereitet …");
  const [error, setError] = useState("");
  const [currentZoom, setCurrentZoom] = useState(
    initialDataset.zoomLevels[0],
  );
  const [results, setResults] = useState([]);
  const [featureTimer, setFeatureTimer] = useState(emptyTimer);
  const [parquetTimer, setParquetTimer] = useState(emptyTimer);
  const [showInfo, setShowInfo] = useState(false);

  const dataset = DATASETS[selectedDatasetId];
  const stages = getStages(dataset);

  const timerSetters = {
    feature: setFeatureTimer,
    parquet: setParquetTimer,
  };

  function clearTimer(type) {
    if (timerIntervalsRef.current[type]) {
      window.clearInterval(timerIntervalsRef.current[type]);
      timerIntervalsRef.current[type] = null;
    }
  }

  function startTimer(type, label) {
    clearTimer(type);

    const start = performance.now();

    const update = () => {
      const elapsed = Math.min(
        performance.now() - start,
        LOAD_TIMEOUT_MS,
      );

      timerSetters[type]({
        milliseconds: elapsed,
        running: elapsed < LOAD_TIMEOUT_MS,
        finished: false,
        timedOut: elapsed >= LOAD_TIMEOUT_MS,
        status: elapsed >= LOAD_TIMEOUT_MS ? "Zeitlimit" : label,
      });

      if (elapsed >= LOAD_TIMEOUT_MS) clearTimer(type);
    };

    timerSetters[type]({
      milliseconds: 0,
      running: true,
      finished: false,
      timedOut: false,
      status: label,
    });

    timerIntervalsRef.current[type] = window.setInterval(update, 50);

    return start;
  }

  function stopTimer(type, start, timedOut) {
    clearTimer(type);

    timerSetters[type]({
      milliseconds: timedOut
        ? LOAD_TIMEOUT_MS
        : Math.min(performance.now() - start, LOAD_TIMEOUT_MS),
      running: false,
      finished: !timedOut,
      timedOut,
      status: timedOut ? "Zeitlimit" : "Geladen",
    });
  }

  function resetTimers() {
    clearTimer("feature");
    clearTimer("parquet");
    setFeatureTimer(emptyTimer());
    setParquetTimer(emptyTimer());
  }

  function synchronizeViews(source, target) {
    return reactiveUtils.watch(
      () => source.viewpoint,
      (viewpoint) => {
        if (
          !viewpoint ||
          syncPausedRef.current ||
          syncLockRef.current
        ) {
          return;
        }

        syncLockRef.current = true;
        target.viewpoint = viewpoint.clone();

        window.clearTimeout(syncTimeoutRef.current);

        syncTimeoutRef.current = window.setTimeout(() => {
          syncLockRef.current = false;
        }, 50);
      },
    );
  }

  useEffect(() => {
    let cancelled = false;
    let featureView;
    let parquetView;

    async function initialize() {
      try {
        if (
          !featureContainerRef.current ||
          !parquetContainerRef.current
        ) {
          throw new Error("Kartencontainer fehlen.");
        }

        esriConfig.portalUrl = PORTAL_URL;

        const initialDataset = DATASETS[DEFAULT_DATASET_ID];

        featureView = new MapView({
          container: featureContainerRef.current,
          map: new Map({ basemap: "gray-vector" }),
          center: initialDataset.mapCenter,
          zoom: initialDataset.zoomLevels[0],
          constraints: {
            snapToZoom: false,
          },
        });

        parquetView = new MapView({
          container: parquetContainerRef.current,
          map: new Map({ basemap: "gray-vector" }),
          center: initialDataset.mapCenter,
          zoom: initialDataset.zoomLevels[0],
          constraints: {
            snapToZoom: false,
          },
        });

        await Promise.all([
          featureView.when(),
          parquetView.when(),
        ]);

        if (cancelled) return;

        const featureToParquet = synchronizeViews(
          featureView,
          parquetView,
        );

        const parquetToFeature = synchronizeViews(
          parquetView,
          featureView,
        );

        const zoomHandle = reactiveUtils.watch(
          () => featureView.zoom,
          (zoom) =>
            Number.isFinite(zoom) &&
            setCurrentZoom(Number(zoom.toFixed(1))),
          { initial: true },
        );

        runtimeRef.current = {
          featureView,
          parquetView,
          featureMap: featureView.map,
          parquetMap: parquetView.map,
          featureLayer: null,
          parquetLayer: null,
          featureLayerView: null,
          parquetLayerView: null,
          handles: [
            featureToParquet,
            parquetToFeature,
            zoomHandle,
          ],
        };

        setReady(true);
        setStatus("Bereit zum Start");
      } catch (cause) {
        if (!cancelled) {
          setError(formatError(cause));
          setStatus("Initialisierung fehlgeschlagen");
        }
      }
    }

    initialize();

    return () => {
      cancelled = true;

      clearTimer("feature");
      clearTimer("parquet");

      runtimeRef.current?.handles.forEach((handle) =>
        handle.remove(),
      );

      window.clearTimeout(syncTimeoutRef.current);

      featureView?.destroy();
      parquetView?.destroy();

      runtimeRef.current = null;
    };
  }, []);

  function createLayers(selected) {
    const featureLayer = selected.featureLayerUrl
      ? new FeatureLayer({
          url: selected.featureLayerUrl,
          outFields: ["*"],
          renderer: createRenderer(
            selected.geometryType,
            [18, 105, 255, 0.78],
          ),
          popupEnabled: false,
        })
      : new FeatureLayer({
          portalItem: {
            id: selected.featureLayerItemId,
          },
          outFields: ["*"],
          renderer: createRenderer(
            selected.geometryType,
            [18, 105, 255, 0.78],
          ),
          popupEnabled: false,
        });

    return {
      featureLayer,

      parquetLayer: new ParquetLayer({
        title: `${selected.label} GeoParquet`,
        data: new ParquetPortalItemData({
          portalItem: {
            id: selected.parquetItemId,
          },
        }),
        renderer: createRenderer(
          selected.geometryType,
          [249, 115, 22, 0.82],
        ),
        popupEnabled: false,
      }),
    };
  }

  async function removeLayers() {
    const runtime = runtimeRef.current;

    if (!runtime) return;

    runtime.featureLayerView = null;
    runtime.parquetLayerView = null;

    for (const type of ["feature", "parquet"]) {
      const layer = runtime[`${type}Layer`];

      if (layer) {
        runtime[`${type}Map`].remove(layer);
        layer.destroy();
        runtime[`${type}Layer`] = null;
      }
    }

    await waitForFrames();
  }

  async function setViewpoints(selectedDataset, zoom) {
    const runtime = runtimeRef.current;

    if (!runtime) {
      throw new Error("Die Karten sind noch nicht bereit.");
    }

    syncPausedRef.current = true;

    try {
      await Promise.all(
        ["feature", "parquet"].map((type) =>
          runtime[`${type}View`].goTo(
            {
              center: selectedDataset.mapCenter,
              zoom,
            },
            {
              animate: false,
            },
          ),
        ),
      );

      await Promise.all(
        ["feature", "parquet"].map((type) =>
          reactiveUtils.whenOnce(
            () => runtime[`${type}View`].stationary,
          ),
        ),
      );

      setCurrentZoom(zoom);
    } finally {
      syncPausedRef.current = false;
      syncLockRef.current = false;
    }
  }

  async function loadLayer(type, layer) {
    const runtime = runtimeRef.current;
    const label =
      type === "feature" ? "Feature Layer" : "GeoParquet";
    const start = startTimer(type, "Lädt …");

    let layerView = null;
    let timedOut = false;

    runtime[`${type}Map`].add(layer);

    try {
      await withTimeout(
        (async () => {
          setStatus(`${label} wird geladen …`);

          await layer.load();

          console.log(`${label} geladen`);
          console.log("Loaded:", layer.loaded);
          console.log("URL:", layer.url);
          console.log("Feature Count?", layer.sourceJSON);

          layerView =
            await runtime[`${type}View`].whenLayerView(layer);

          console.log(`${label} LayerView erzeugt`);

          await waitForFrames();

          await waitForLayerView(
            runtime[`${type}View`],
            layerView,
          );

          await waitForFrames();
        })(),
        `${label}: Zeitlimit erreicht.`,
      );
    } catch (cause) {
      timedOut = true;
      console.warn(`${label}:`, cause);
    }

    stopTimer(type, start, timedOut);

    return {
      duration: timedOut
        ? LOAD_TIMEOUT_MS
        : Math.min(performance.now() - start, LOAD_TIMEOUT_MS),
      timedOut,
      layerView,
    };
  }

  async function measureZoom(type, selectedDataset, zoom) {
    const runtime = runtimeRef.current;
    const start = startTimer(type, `Zoom ${zoom} …`);

    let timedOut = false;

    try {
      await withTimeout(
        (async () => {
          const layerView = runtime[`${type}LayerView`];

          if (!layerView) {
            throw new Error("Keine LayerView verfügbar.");
          }

          await runtime[`${type}View`].goTo(
            {
              center: selectedDataset.mapCenter,
              zoom,
            },
            {
              animate: false,
            },
          );

          await waitForLayerView(
            runtime[`${type}View`],
            layerView,
          );

          await waitForFrames();
        })(),
        `Zoom ${zoom}: Zeitlimit erreicht.`,
      );
    } catch (cause) {
      timedOut = true;
      console.warn(`${type}, Zoom ${zoom}:`, cause);
    }

    stopTimer(type, start, timedOut);

    return {
      duration: timedOut
        ? LOAD_TIMEOUT_MS
        : Math.min(performance.now() - start, LOAD_TIMEOUT_MS),
      timedOut,
    };
  }

  async function runComparison() {
    const runtime = runtimeRef.current;

    if (!runtime || running) return;

    const selectedDataset = dataset;
    const selectedStages = getStages(selectedDataset);

    setRunning(true);
    setError("");
    setResults([]);
    resetTimers();

    try {
      await removeLayers();

      // Start at the first zoom configured for this dataset.
      await setViewpoints(
        selectedDataset,
        selectedStages[0].zoom,
      );

      const layers = createLayers(selectedDataset);

      runtime.featureLayer = layers.featureLayer;
      runtime.parquetLayer = layers.parquetLayer;

      setStatus(`1/3 · ${selectedStages[0].label} wird gemessen`);

      const [featureLoad, parquetLoad] = await Promise.all([
        loadLayer("feature", layers.featureLayer),
        loadLayer("parquet", layers.parquetLayer),
      ]);

      runtime.featureLayerView = featureLoad.layerView;
      runtime.parquetLayerView = parquetLoad.layerView;

      const completed = [
        resultFrom(
          selectedStages[0],
          featureLoad,
          parquetLoad,
        ),
      ];

      setResults([...completed]);

      for (
        let index = 1;
        index < selectedStages.length;
        index += 1
      ) {
        const stage = selectedStages[index];

        setStatus(
          `${index + 1}/3 · ${stage.label} wird gemessen`,
        );

        syncPausedRef.current = true;

        const [feature, parquet] = await Promise.all([
          measureZoom(
            "feature",
            selectedDataset,
            stage.zoom,
          ),
          measureZoom(
            "parquet",
            selectedDataset,
            stage.zoom,
          ),
        ]);

        syncPausedRef.current = false;
        syncLockRef.current = false;

        completed.push(
          resultFrom(stage, feature, parquet),
        );

        setResults([...completed]);
        setCurrentZoom(stage.zoom);
      }

      setStatus("Vergleich abgeschlossen");
    } catch (cause) {
      setError(formatError(cause));
      setStatus("Analyse fehlgeschlagen");
    } finally {
      syncPausedRef.current = false;
      syncLockRef.current = false;
      setRunning(false);
    }
  }

  async function resetAnalysis() {
    if (running) return;

    resetTimers();
    setResults([]);
    setError("");

    try {
      await removeLayers();

      await setViewpoints(
        dataset,
        dataset.zoomLevels[0],
      );

      setStatus("Bereit zum Start");
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function changeDataset(event) {
    if (running) return;

    // Important: use the newly selected dataset here.
    // React state does not update synchronously.
    const nextDatasetId = event.target.value;
    const nextDataset = DATASETS[nextDatasetId];

    setSelectedDatasetId(nextDatasetId);
    resetTimers();
    setResults([]);
    setError("");

    try {
      await removeLayers();

      await setViewpoints(
        nextDataset,
        nextDataset.zoomLevels[0],
      );

      setStatus("Bereit zum Start");
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  const activeStage = running
    ? Math.min(results.length, stages.length - 1)
    : -1;

  return (
    <div className="app-shell">
      {showInfo && (
        <InfoModal onClose={() => setShowInfo(false)} />
      )}

      <header className="app-header">
        <div className="brand-mark">
          <MapIcon size={22} />
        </div>

        <div className="brand-copy">
          <h1>GeoParquet Speed Test</h1>
          <p>
            Gleiche Daten. Zwei Layer-Typen. Ein direkter
            Ladezeitvergleich.
          </p>
        </div>

        <div
          className={`status-pill ${
            running ? "running" : ready ? "ready" : ""
          }`}
        >
          <span />
          {status}
        </div>

        <button
          className="icon-button"
          onClick={() => setShowInfo(true)}
          aria-label="Über GeoParquet"
        >
          <CircleHelp size={19} />
        </button>
      </header>

      <main className="dashboard">
        <aside className="control-panel">
          <div className="panel-kicker">So funktioniert’s</div>

          <h2>In drei Schritten zum Ergebnis</h2>

          <ol className="workflow">
            <li className="current">
              <span>1</span>

              <div>
                <strong>Datensatz wählen</strong>
                <small>
                  Beide Layer enthalten identische Daten.
                </small>
              </div>
            </li>

            <li
              className={
                results.length
                  ? "done"
                  : running
                    ? "current"
                    : ""
              }
            >
              <span>
                {results.length ? <Check size={14} /> : "2"}
              </span>

              <div>
                <strong>Benchmark starten</strong>
                <small>
                  Die App lädt beide Layer gleichzeitig.
                </small>
              </div>
            </li>

            <li
              className={
                results.length === 3
                  ? "done"
                  : running && results.length
                    ? "current"
                    : ""
              }
            >
              <span>
                {results.length === 3 ? (
                  <Check size={14} />
                ) : (
                  "3"
                )}
              </span>

              <div>
                <strong>Zeiten vergleichen</strong>
                <small>
                  Drei Zoomstufen zeigen die Performance.
                </small>
              </div>
            </li>
          </ol>

          <label className="dataset-field">
            <span>Testdatensatz</span>

            <select
              value={selectedDatasetId}
              onChange={changeDataset}
              disabled={running}
            >
              {Object.entries(DATASETS).map(([id, item]) => (
                <option key={id} value={id}>
                  {item.label}
                </option>
              ))}
            </select>

            <small>
              {numberFormatter.format(dataset.totalFeatures)} Features
            </small>
          </label>

          <button
            className="run-button"
            onClick={runComparison}
            disabled={!ready || running}
          >
            <Play size={18} fill="currentColor" />

            {running
              ? "Benchmark läuft …"
              : results.length
                ? "Erneut vergleichen"
                : "Vergleich starten"}
          </button>

          <button
            className="reset-button"
            onClick={resetAnalysis}
            disabled={!ready || running || !results.length}
          >
            <RotateCcw size={15} /> Ergebnis zurücksetzen
          </button>

          <div className="test-note">
            <Info size={16} />

            <p>
              Gemessen wird bis beide Karten fertig gezeichnet sind.
              Zeitlimit: 30 Sekunden.
            </p>
          </div>
        </aside>

        <section
          className="comparison-panel"
          aria-label="Synchronisierte Kartenansichten"
        >
          <div className="comparison-heading">
            <div>
              <span className="panel-kicker">
                Live-Vergleich
              </span>

              <h2>{dataset.description}</h2>
            </div>

            <span className="sync-label">
              <Zap size={14} /> Karten sind synchronisiert
            </span>
          </div>

          <div className="maps-grid">
            <MapPanel
              type="feature"
              dataset={dataset}
              zoom={currentZoom}
              timer={featureTimer}
              containerRef={featureContainerRef}
            />

            <div className="versus">VS</div>

            <MapPanel
              type="parquet"
              dataset={dataset}
              zoom={currentZoom}
              timer={parquetTimer}
              containerRef={parquetContainerRef}
            />
          </div>

          {error && (
            <div className="error-banner">
              <Info size={16} />
              {error}
            </div>
          )}
        </section>

        <aside className="results-panel">
          <div className="results-heading">
            <div>
              <span className="panel-kicker">Ergebnis</span>
              <h2>Drei Zoomstufen</h2>
            </div>

            <Gauge size={22} />
          </div>

          <div className="legend">
            <span>
              <i className="feature-color" />
              Feature Layer
            </span>

            <span>
              <i className="parquet-color" />
              GeoParquet
            </span>
          </div>

          <div className="stage-list">
            {stages.map((stage, index) => (
              <StageResult
                key={stage.id}
                stage={stage}
                result={results[index]}
                active={activeStage === index}
              />
            ))}
          </div>

          <div className="result-footnote">
            Niedrigere Ladezeit gewinnt.
          </div>
        </aside>
      </main>
    </div>
  );
}