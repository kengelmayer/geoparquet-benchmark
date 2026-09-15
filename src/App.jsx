import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Database,
  Download,
  Gauge,
  Info,
  Layers3,
  Map as MapIcon,
  Play,
  RotateCcw,
  Sparkles,
  Timer,
  Trophy,
  X,
  Zap,
} from "lucide-react";

import esriConfig from "@arcgis/core/config.js";
import Map from "@arcgis/core/Map.js";
import MapView from "@arcgis/core/views/MapView.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import ParquetLayer from "@arcgis/core/layers/ParquetLayer.js";
import ParquetPortalItemData from "@arcgis/core/layers/support/ParquetPortalItemData.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";

/* -------------------------------------------------------------------------- */
/* Konfiguration                                                              */
/* -------------------------------------------------------------------------- */

const PORTAL_URL = "https://www.arcgis.com";
const BASEMAP = "gray-vector";

const PARQUET_INFO_URL =
  "https://www.esri.com/arcgis-blog/products/arcgis-online/announcements/scaling-your-gis-workflows-with-the-new-parquet-feature-layer-beta-in-arcgis-online";

const MAP_CENTER = [10.4, 51.1];

const INITIAL_VIEWPOINT = {
  center: MAP_CENTER,
  zoom: 5,
};

const LOAD_TIMEOUT_MS = 30000;

const ZOOM_STAGES = [
  {
    id: "deutschland",
    label: "Deutschland",
    zoom: 5,
    description: "Deutschlandweite Ansicht und erstmaliges Laden",
  },
  {
    id: "regional",
    label: "Regional",
    zoom: 7,
    description: "Regionale Ansicht nach dem Zoomen",
  },
  {
    id: "lokal",
    label: "Lokal",
    zoom: 9,
    description: "Lokale Ansicht nach dem Zoomen",
  },
];

const DATASETS = {
  haltestellen: {
    id: "haltestellen",
    label: "Haltestellen",
    description: "Haltestellen in Deutschland",
    geometryType: "point",
    totalFeatures: 719525,

    parquetItemId:
      "f110c8c9a2ef47e096ed6b1b5ca21f00",

    featureLayerItemId:
      "b0f19ce050d74cf0a5f6d5937b4efa0d",
  },

  radwege: {
    id: "radwege",
    label: "Radwege",
    description: "Radwege in Deutschland",
    geometryType: "polyline",
    totalFeatures: 795657,

    parquetItemId:
      "f5bf927307854cefa9c5cb0cec5e2fa0",

    featureLayerItemId:
      "298312d8d3534ad28e6d6d9355d62228",
  },
};

/* -------------------------------------------------------------------------- */
/* Hilfsfunktionen                                                            */
/* -------------------------------------------------------------------------- */

function waitForFrames(numberOfFrames = 2) {
  return new Promise((resolve) => {
    let remainingFrames = numberOfFrames;

    function nextFrame() {
      if (remainingFrames <= 0) {
        resolve();
        return;
      }

      remainingFrames -= 1;
      requestAnimationFrame(nextFrame);
    }

    nextFrame();
  });
}

function withTimeout(
  promise,
  timeoutMilliseconds,
  timeoutMessage,
) {
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMilliseconds);
  });

  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }),

    timeoutPromise,
  ]);
}

/*
 * Die Messung endet, wenn:
 *
 * 1. die Kartenansicht stillsteht,
 * 2. die LayerView nicht mehr aktualisiert wird,
 * 3. die LayerView nicht ausgesetzt ist.
 *
 * Es gibt bewusst kein zusätzliches 300-ms-Stabilitätsfenster.
 */
function waitForLayerViewReady({
  view,
  layerView,
}) {
  return reactiveUtils.whenOnce(
    () =>
      view.stationary &&
      !layerView.updating &&
      !layerView.suspended,
  );
}

function formatSeconds(milliseconds) {
  if (milliseconds == null) {
    return "–";
  }

  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(milliseconds / 1000);
}

function formatNumber(value) {
  if (value == null) {
    return "–";
  }

  return new Intl.NumberFormat("de-DE").format(value);
}

function formatArcGISError(error) {
  const messages = [
    error?.name,
    error?.message,
    ...(error?.details?.messages ?? []),
  ].filter(Boolean);

  if (messages.length > 0) {
    return messages.join(": ");
  }

  return "Unbekannter Fehler bei der ArcGIS-Analyse.";
}

function createRenderer(
  geometryType,
  color,
) {
  if (geometryType === "polyline") {
    return {
      type: "simple",

      symbol: {
        type: "simple-line",
        color,
        width: 1.2,
        style: "solid",
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
        color: [255, 255, 255, 0.25],
        width: 0.25,
      },
    },
  };
}

function getWinner({
  featureMilliseconds,
  parquetMilliseconds,
  featureTimedOut = false,
  parquetTimedOut = false,
}) {
  if (featureTimedOut && !parquetTimedOut) {
    return "GeoParquet";
  }

  if (parquetTimedOut && !featureTimedOut) {
    return "Feature Layer";
  }

  if (featureTimedOut && parquetTimedOut) {
    return "Kein Ergebnis";
  }

  if (
    featureMilliseconds == null ||
    parquetMilliseconds == null
  ) {
    return null;
  }

  if (featureMilliseconds < parquetMilliseconds) {
    return "Feature Layer";
  }

  if (parquetMilliseconds < featureMilliseconds) {
    return "GeoParquet";
  }

  return "Gleichstand";
}

function getWinnerKey(result) {
  if (!result) {
    return null;
  }

  const winner = getWinner({
    featureMilliseconds: result.featureMs,
    parquetMilliseconds: result.parquetMs,
    featureTimedOut: result.featureTimedOut,
    parquetTimedOut: result.parquetTimedOut,
  });

  if (winner === "Feature Layer") {
    return "feature";
  }

  if (winner === "GeoParquet") {
    return "parquet";
  }

  if (winner === "Gleichstand") {
    return "tie";
  }

  return null;
}

function getCompletenessText({
  timedOut,
  maximumNumberOfFeaturesExceeded,
  hasAllFeaturesInView,
}) {
  if (timedOut) {
    return "Zeitlimit von 30 Sekunden erreicht";
  }

  if (maximumNumberOfFeaturesExceeded) {
    return "Darstellung abgeschlossen, Feature-Limit erreicht";
  }

  if (hasAllFeaturesInView === true) {
    return "Alle verfügbaren Features im Ausschnitt dargestellt";
  }

  return "Darstellung abgeschlossen";
}

function createInitialTimerState() {
  return {
    milliseconds: 0,
    running: false,
    finished: false,
    timedOut: false,
    status: "Bereit",
  };
}

/* -------------------------------------------------------------------------- */
/* UI-Komponenten                                                             */
/* -------------------------------------------------------------------------- */

function ParquetInfoModal({
  isOpen,
  onClose,
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="parquet-info-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[2rem] border border-white/50 bg-white/90 shadow-2xl backdrop-blur-xl">
        <div className="relative overflow-hidden rounded-t-[2rem] bg-gradient-to-br from-violet-600 via-blue-600 to-cyan-500 px-6 py-7 text-white sm:px-8">
          <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-white/15 blur-2xl" />

          <div className="absolute -bottom-20 -left-12 h-48 w-48 rounded-full bg-cyan-300/20 blur-2xl" />

          <button
            type="button"
            onClick={onClose}
            aria-label="Informationsfenster schließen"
            className="absolute right-4 top-4 rounded-full border border-white/30 bg-white/15 p-2 text-white transition hover:scale-105 hover:bg-white/25"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="relative">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" />
              Neu in ArcGIS Online
            </div>

            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-white/15 p-3 shadow-inner backdrop-blur">
                <Database className="h-8 w-8" />
              </div>

              <div>
                <h2
                  id="parquet-info-title"
                  className="text-2xl font-bold tracking-tight sm:text-3xl"
                >
                  Parquet Feature Layer
                </h2>

                <p className="mt-2 max-w-xl text-sm leading-6 text-blue-50 sm:text-base">
                  Ein neuer Layer-Typ für schnelle und
                  skalierbare Karten mit sehr großen
                  Geodatensätzen.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 sm:p-8">
          <p className="text-sm leading-6 text-slate-600">
            Parquet Feature Layer kombinieren die
            spaltenbasierte Speicherung von Parquet mit
            räumlicher Optimierung. Dadurch können große,
            schreibgeschützte Referenzdatensätze effizient
            visualisiert und clientseitig abgefragt werden.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
              <Zap className="h-5 w-5 text-violet-600" />

              <p className="mt-3 text-sm font-semibold text-violet-950">
                Schnelles Zeichnen
              </p>

              <p className="mt-1 text-xs leading-5 text-violet-700">
                Für große Datenmengen und schnelle
                Kartendarstellung optimiert.
              </p>
            </div>

            <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4">
              <Layers3 className="h-5 w-5 text-blue-600" />

              <p className="mt-3 text-sm font-semibold text-blue-950">
                Mehrere Maßstäbe
              </p>

              <p className="mt-1 text-xs leading-5 text-blue-700">
                Generalisierte Geometrien unterstützen
                unterschiedliche Zoomstufen.
              </p>
            </div>

            <div className="rounded-2xl border border-cyan-100 bg-cyan-50 p-4">
              <Gauge className="h-5 w-5 text-cyan-600" />

              <p className="mt-3 text-sm font-semibold text-cyan-950">
                Große Datensätze
              </p>

              <p className="mt-1 text-xs leading-5 text-cyan-700">
                Besonders für große und räumlich verteilte
                Referenzdaten geeignet.
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />

              <div>
                <p className="text-sm font-semibold text-amber-950">
                  Aktuell als Beta verfügbar
                </p>

                <p className="mt-1 text-xs leading-5 text-amber-800">
                  Parquet Feature Layer sind primär für
                  schreibgeschützte Visualisierungs- und
                  Referenzworkflows vorgesehen. Einige
                  Funktionen unterscheiden sich daher von
                  klassischen Feature Layern.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Benchmark ansehen
            </button>

            <a
              href={PARQUET_INFO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
            >
              Mehr erfahren
              <ArrowUpRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  active = false,
  winner = false,
  warning = false,
  color = "blue",
}) {
  let colorClasses =
    "border-white/80 bg-white/85 shadow-slate-900/5";

  if (active) {
    colorClasses =
      "border-amber-300 bg-amber-50/90 shadow-amber-900/10";
  }

  if (winner) {
    colorClasses =
      "border-emerald-300 bg-emerald-50/90 shadow-emerald-900/10";
  }

  if (warning) {
    colorClasses =
      "border-red-300 bg-red-50/90 shadow-red-900/10";
  }

  const indicatorClasses =
    color === "orange"
      ? "bg-orange-500"
      : color === "blue"
        ? "bg-blue-600"
        : "bg-violet-500";

  return (
    <div
      className={`rounded-[1.5rem] border p-4 shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl ${colorClasses}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-3 w-3 rounded-full shadow-sm ${indicatorClasses}`}
          />

          <p className="text-sm font-medium text-slate-500">
            {title}
          </p>
        </div>

        {winner && (
          <Trophy className="h-4 w-4 text-emerald-600" />
        )}

        {warning && (
          <AlertCircle className="h-4 w-4 text-red-600" />
        )}
      </div>

      <p
        className={`mt-2 font-bold tracking-tight ${
          warning
            ? "text-lg text-red-800"
            : "text-2xl text-slate-900"
        }`}
      >
        {value}
      </p>

      <p className="mt-1 text-xs leading-5 text-slate-500">
        {subtitle}
      </p>
    </div>
  );
}

function MapLabel({
  title,
  subtitle,
  color,
}) {
  const indicatorClasses =
    color === "orange"
      ? "bg-orange-500"
      : "bg-blue-600";

  return (
    <div className="absolute left-3 top-3 z-10 rounded-2xl border border-white/70 bg-white/85 px-3 py-2 shadow-lg backdrop-blur-md">
      <div className="flex items-center gap-2">
        <span
          className={`h-3 w-3 rounded-full shadow-sm ${indicatorClasses}`}
        />

        <p className="text-sm font-semibold text-slate-900">
          {title}
        </p>
      </div>

      <p className="mt-1 text-xs text-slate-500">
        {subtitle}
      </p>
    </div>
  );
}

function MapTimer({
  timer,
  color,
}) {
  let statusClasses =
    "bg-slate-100 text-slate-600";

  let valueClasses =
    "text-slate-900";

  if (timer.running) {
    statusClasses =
      "bg-amber-100 text-amber-800";

    valueClasses =
      "text-amber-700";
  }

  if (timer.finished) {
    statusClasses =
      "bg-emerald-100 text-emerald-800";

    valueClasses =
      color === "orange"
        ? "text-orange-600"
        : "text-blue-700";
  }

  if (timer.timedOut) {
    statusClasses =
      "bg-red-100 text-red-800";

    valueClasses =
      "text-red-700";
  }

  return (
    <div className="absolute bottom-4 left-1/2 z-20 min-w-[190px] -translate-x-1/2 rounded-2xl border border-white/70 bg-white/90 px-5 py-3 text-center shadow-xl backdrop-blur-md">
      <div className="flex items-center justify-center gap-2">
        <Timer className="h-4 w-4 text-slate-500" />

        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Ladezeit
        </span>
      </div>

      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${valueClasses}`}
      >
        {timer.timedOut
          ? "> 30,00 s"
          : `${formatSeconds(
              timer.milliseconds,
            )} s`}
      </p>

      <span
        className={`mt-2 inline-block rounded-full px-2 py-1 text-xs font-medium ${statusClasses}`}
      >
        {timer.status}
      </span>
    </div>
  );
}

function ZoomResultCard({ result }) {
  const winnerKey = getWinnerKey(result);

  return (
    <div className="rounded-[1.5rem] border border-white/80 bg-white/85 p-4 shadow-lg shadow-slate-900/5 backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-slate-900">
            {result.label}
          </p>

          <p className="text-xs text-slate-500">
            Zoom {result.zoom} ·{" "}
            {result.description}
          </p>
        </div>

        {result.winner && (
          <span
            className={`rounded-full px-2 py-1 text-xs font-medium ${
              result.featureTimedOut &&
              result.parquetTimedOut
                ? "bg-red-100 text-red-800"
                : "bg-emerald-100 text-emerald-800"
            }`}
          >
            {result.winner}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div
          className={`rounded-xl p-3 ${
            result.featureTimedOut
              ? "bg-red-50"
              : winnerKey === "feature"
                ? "bg-emerald-50"
                : "bg-blue-50"
          }`}
        >
          <p className="text-xs text-slate-500">
            Feature Layer
          </p>

          <p
            className={`mt-1 text-lg font-bold ${
              result.featureTimedOut
                ? "text-red-700"
                : "text-slate-900"
            }`}
          >
            {result.featureTimedOut
              ? "> 30,00 s"
              : `${formatSeconds(
                  result.featureMs,
                )} s`}
          </p>
        </div>

        <div
          className={`rounded-xl p-3 ${
            result.parquetTimedOut
              ? "bg-red-50"
              : winnerKey === "parquet"
                ? "bg-emerald-50"
                : "bg-orange-50"
          }`}
        >
          <p className="text-xs text-slate-500">
            GeoParquet
          </p>

          <p
            className={`mt-1 text-lg font-bold ${
              result.parquetTimedOut
                ? "text-red-700"
                : "text-slate-900"
            }`}
          >
            {result.parquetTimedOut
              ? "> 30,00 s"
              : `${formatSeconds(
                  result.parquetMs,
                )} s`}
          </p>
        </div>
      </div>

      {result.featureTimedOut ||
      result.parquetTimedOut ? (
        <p className="mt-3 text-xs font-medium text-red-700">
          Mindestens ein Layer hat das
          Zeitlimit von 30 Sekunden erreicht.
        </p>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          Unterschied:{" "}
          <strong className="text-slate-700">
            {formatSeconds(
              result.differenceMs,
            )}{" "}
            s
          </strong>
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export default function App() {
  const featureContainerRef = useRef(null);
  const parquetContainerRef = useRef(null);

  const runtimeRef = useRef(null);
  const historyRef = useRef([]);

  const synchronizationLockRef =
    useRef(false);

  const synchronizationPausedRef =
    useRef(false);

  const synchronizationTimeoutRef =
    useRef(null);

  const featureTimerIntervalRef =
    useRef(null);

  const parquetTimerIntervalRef =
    useRef(null);

  const [showInfoModal, setShowInfoModal] =
    useState(true);

  const [
    selectedDatasetId,
    setSelectedDatasetId,
  ] = useState("haltestellen");

  const [ready, setReady] =
    useState(false);

  const [running, setRunning] =
    useState(false);

  const [status, setStatus] =
    useState(
      "ArcGIS-Karten werden initialisiert ...",
    );

  const [error, setError] =
    useState("");

  const [currentZoom, setCurrentZoom] =
    useState(INITIAL_VIEWPOINT.zoom);

  const [results, setResults] =
    useState([]);

  const [history, setHistory] =
    useState([]);

  const [
    featureTimer,
    setFeatureTimer,
  ] = useState(createInitialTimerState);

  const [
    parquetTimer,
    setParquetTimer,
  ] = useState(createInitialTimerState);

  const selectedDataset =
    DATASETS[selectedDatasetId];

  const germanyResult =
    results.find(
      (result) =>
        result.stageId === "deutschland",
    ) ?? null;

  const germanyWinnerKey =
    getWinnerKey(germanyResult);

  function getTimerConfiguration(
    layerType,
  ) {
    if (layerType === "feature") {
      return {
        intervalRef:
          featureTimerIntervalRef,

        setTimer:
          setFeatureTimer,
      };
    }

    return {
      intervalRef:
        parquetTimerIntervalRef,

      setTimer:
        setParquetTimer,
    };
  }

  function clearTimerInterval(
    layerType,
  ) {
    const { intervalRef } =
      getTimerConfiguration(layerType);

    if (intervalRef.current) {
      window.clearInterval(
        intervalRef.current,
      );

      intervalRef.current = null;
    }
  }

  function startMapTimer(
    layerType,
    statusText = "Lädt ...",
  ) {
    const {
      intervalRef,
      setTimer,
    } = getTimerConfiguration(
      layerType,
    );

    clearTimerInterval(layerType);

    const startTime =
      performance.now();

    setTimer({
      milliseconds: 0,
      running: true,
      finished: false,
      timedOut: false,
      status: statusText,
    });

    intervalRef.current =
      window.setInterval(() => {
        const elapsed =
          performance.now() -
          startTime;

        if (elapsed >= LOAD_TIMEOUT_MS) {
          window.clearInterval(
            intervalRef.current,
          );

          intervalRef.current = null;

          setTimer({
            milliseconds:
              LOAD_TIMEOUT_MS,

            running: false,
            finished: false,
            timedOut: true,

            status:
              "Zeitlimit erreicht",
          });

          return;
        }

        setTimer({
          milliseconds: elapsed,
          running: true,
          finished: false,
          timedOut: false,
          status: statusText,
        });
      }, 50);

    return startTime;
  }

  function stopMapTimer(
    layerType,
    startTime,
    timedOut = false,
  ) {
    const { setTimer } =
      getTimerConfiguration(
        layerType,
      );

    clearTimerInterval(layerType);

    const elapsed = timedOut
      ? LOAD_TIMEOUT_MS
      : Math.min(
          performance.now() -
            startTime,
          LOAD_TIMEOUT_MS,
        );

    setTimer({
      milliseconds: elapsed,
      running: false,
      finished: !timedOut,
      timedOut,

      status: timedOut
        ? "Zeitlimit erreicht"
        : "Geladen",
    });
  }

  function resetMapTimers() {
    clearTimerInterval("feature");
    clearTimerInterval("parquet");

    setFeatureTimer(
      createInitialTimerState(),
    );

    setParquetTimer(
      createInitialTimerState(),
    );
  }

  function synchronizeViews(
    sourceView,
    targetView,
  ) {
    return reactiveUtils.watch(
      () => sourceView.viewpoint,

      (viewpoint) => {
        if (
          !viewpoint ||
          synchronizationPausedRef.current ||
          synchronizationLockRef.current
        ) {
          return;
        }

        synchronizationLockRef.current =
          true;

        targetView.viewpoint =
          viewpoint.clone();

        if (
          synchronizationTimeoutRef.current
        ) {
          window.clearTimeout(
            synchronizationTimeoutRef.current,
          );
        }

        synchronizationTimeoutRef.current =
          window.setTimeout(() => {
            synchronizationLockRef.current =
              false;
          }, 50);
      },
    );
  }

  useEffect(() => {
    let cancelled = false;
    let localFeatureView = null;
    let localParquetView = null;

    async function initializeMaps() {
      try {
        const featureContainer =
          featureContainerRef.current;

        const parquetContainer =
          parquetContainerRef.current;

        if (
          !(
            featureContainer instanceof
            HTMLElement
          ) ||
          !(
            parquetContainer instanceof
            HTMLElement
          )
        ) {
          throw new Error(
            "Die Kartencontainer sind noch nicht verfügbar.",
          );
        }

        esriConfig.portalUrl =
          PORTAL_URL;

        const featureMap = new Map({
          basemap: BASEMAP,
        });

        const parquetMap = new Map({
          basemap: BASEMAP,
        });

        const commonViewProperties = {
          center:
            INITIAL_VIEWPOINT.center,

          zoom:
            INITIAL_VIEWPOINT.zoom,

          constraints: {
            snapToZoom: false,
          },
        };

        const featureView =
          new MapView({
            ...commonViewProperties,

            container:
              featureContainer,

            map:
              featureMap,
          });

        const parquetView =
          new MapView({
            ...commonViewProperties,

            container:
              parquetContainer,

            map:
              parquetMap,
          });

        localFeatureView =
          featureView;

        localParquetView =
          parquetView;

        await Promise.all([
          featureView.when(),
          parquetView.when(),
        ]);

        if (cancelled) {
          return;
        }

        const featureToParquetHandle =
          synchronizeViews(
            featureView,
            parquetView,
          );

        const parquetToFeatureHandle =
          synchronizeViews(
            parquetView,
            featureView,
          );

        const zoomHandle =
          reactiveUtils.watch(
            () => featureView.zoom,

            (zoom) => {
              if (Number.isFinite(zoom)) {
                setCurrentZoom(
                  Number(
                    zoom.toFixed(2),
                  ),
                );
              }
            },

            {
              initial: true,
            },
          );

        runtimeRef.current = {
          featureMap,
          parquetMap,
          featureView,
          parquetView,

          featureLayer: null,
          parquetLayer: null,

          featureLayerView: null,
          parquetLayerView: null,

          featureToParquetHandle,
          parquetToFeatureHandle,
          zoomHandle,
        };

        setReady(true);

        setStatus(
          "Bereit für die Analyse",
        );
      } catch (cause) {
        if (cancelled) {
          return;
        }

        console.error(
          "ArcGIS initialization failed:",
          cause,
        );

        setError(
          formatArcGISError(cause),
        );

        setStatus(
          "Initialisierung fehlgeschlagen",
        );
      }
    }

    initializeMaps();

    return () => {
      cancelled = true;

      clearTimerInterval("feature");
      clearTimerInterval("parquet");

      const runtime =
        runtimeRef.current;

      runtime
        ?.featureToParquetHandle
        ?.remove();

      runtime
        ?.parquetToFeatureHandle
        ?.remove();

      runtime
        ?.zoomHandle
        ?.remove();

      if (
        synchronizationTimeoutRef.current
      ) {
        window.clearTimeout(
          synchronizationTimeoutRef.current,
        );
      }

      localFeatureView?.destroy();
      localParquetView?.destroy();

      runtimeRef.current = null;
    };
  }, []);

  function createTestLayers(dataset) {
    const featureLayer =
      new FeatureLayer({
        title:
          `${dataset.label} Deutschland Feature Layer`,

        portalItem: {
          id:
            dataset.featureLayerItemId,
        },

        outFields: [],

        renderer: createRenderer(
          dataset.geometryType,
          [0, 122, 194, 0.72],
        ),

        popupEnabled: false,
        visible: true,
        minScale: 0,
        maxScale: 0,
      });

    const parquetLayer =
      new ParquetLayer({
        title:
          `${dataset.label} Deutschland GeoParquet`,

        data:
          new ParquetPortalItemData({
            portalItem: {
              id:
                dataset.parquetItemId,
            },
          }),

        renderer: createRenderer(
          dataset.geometryType,
          [230, 112, 30, 0.72],
        ),

        popupEnabled: false,
        visible: true,
        minScale: 0,
        maxScale: 0,
      });

    return {
      featureLayer,
      parquetLayer,
    };
  }

  async function removeTestLayers() {
    const runtime =
      runtimeRef.current;

    if (!runtime) {
      return;
    }

    runtime.featureLayerView = null;
    runtime.parquetLayerView = null;

    if (runtime.featureLayer) {
      runtime.featureMap.remove(
        runtime.featureLayer,
      );

      runtime.featureLayer.destroy();
      runtime.featureLayer = null;
    }

    if (runtime.parquetLayer) {
      runtime.parquetMap.remove(
        runtime.parquetLayer,
      );

      runtime.parquetLayer.destroy();
      runtime.parquetLayer = null;
    }

    await waitForFrames(2);
  }

  async function setBothViewpoints(
    zoom,
  ) {
    const runtime =
      runtimeRef.current;

    if (!runtime) {
      throw new Error(
        "Die Karten wurden noch nicht initialisiert.",
      );
    }

    synchronizationPausedRef.current =
      true;

    try {
      await Promise.all([
        runtime.featureView.goTo(
          {
            center: MAP_CENTER,
            zoom,
          },
          {
            animate: false,
          },
        ),

        runtime.parquetView.goTo(
          {
            center: MAP_CENTER,
            zoom,
          },
          {
            animate: false,
          },
        ),
      ]);

      await Promise.all([
        reactiveUtils.whenOnce(
          () =>
            runtime.featureView
              .stationary,
        ),

        reactiveUtils.whenOnce(
          () =>
            runtime.parquetView
              .stationary,
        ),
      ]);

      setCurrentZoom(zoom);
    } finally {
      await waitForFrames(1);

      synchronizationPausedRef.current =
        false;

      synchronizationLockRef.current =
        false;
    }
  }

  async function loadLayerForBenchmark({
    name,
    layerType,
    view,
    map,
    layer,
  }) {
    const startTime =
      startMapTimer(
        layerType,
        "Lädt ...",
      );

    let layerView = null;
    let timedOut = false;

    map.add(layer);

    try {
      /*
       * Das gesamte Laden einschließlich LayerView und
       * Darstellung besitzt zusammen ein Limit von 30 Sekunden.
       */
      await withTimeout(
        (async () => {
          setStatus(
            `${name}: Layer wird geladen ...`,
          );

          await layer.load();

          layerView =
            await view.whenLayerView(
              layer,
            );

          await waitForFrames(2);

          setStatus(
            `${name}: Darstellung läuft ...`,
          );

          await waitForLayerViewReady({
            view,
            layerView,
          });

          await waitForFrames(2);
        })(),

        LOAD_TIMEOUT_MS,

        `${name}: Zeitlimit von 30 Sekunden erreicht.`,
      );
    } catch (cause) {
      timedOut = true;

      console.warn(
        `${name} hat das Zeitlimit erreicht:`,
        cause,
      );
    }

    const duration = timedOut
      ? LOAD_TIMEOUT_MS
      : Math.min(
          performance.now() -
            startTime,
          LOAD_TIMEOUT_MS,
        );

    stopMapTimer(
      layerType,
      startTime,
      timedOut,
    );

    return {
      duration,
      timedOut,
      layerView,

      hasAllFeaturesInView:
        layerView &&
        "hasAllFeaturesInView" in
          layerView
          ? layerView
              .hasAllFeaturesInView
          : null,

      maximumNumberOfFeaturesExceeded:
        layerView &&
        "maximumNumberOfFeaturesExceeded" in
          layerView
          ? layerView
              .maximumNumberOfFeaturesExceeded
          : null,
    };
  }

  async function measureZoomForLayer({
    name,
    layerType,
    view,
    layerView,
    zoom,
  }) {
    const startTime =
      startMapTimer(
        layerType,
        `Zoom ${zoom} lädt ...`,
      );

    let timedOut = false;

    try {
      await withTimeout(
        (async () => {
          if (!layerView) {
            throw new Error(
              `${name}: Keine LayerView verfügbar.`,
            );
          }

          await view.goTo(
            {
              center: MAP_CENTER,
              zoom,
            },
            {
              animate: false,
            },
          );

          await waitForLayerViewReady({
            view,
            layerView,
          });

          await waitForFrames(2);
        })(),

        LOAD_TIMEOUT_MS,

        `${name}: Zeitlimit von 30 Sekunden bei Zoom ${zoom} erreicht.`,
      );
    } catch (cause) {
      timedOut = true;

      console.warn(
        `${name}, Zoom ${zoom}:`,
        cause,
      );
    }

    const duration = timedOut
      ? LOAD_TIMEOUT_MS
      : Math.min(
          performance.now() -
            startTime,
          LOAD_TIMEOUT_MS,
        );

    stopMapTimer(
      layerType,
      startTime,
      timedOut,
    );

    return {
      duration,
      timedOut,

      hasAllFeaturesInView:
        layerView &&
        "hasAllFeaturesInView" in
          layerView
          ? layerView
              .hasAllFeaturesInView
          : null,

      maximumNumberOfFeaturesExceeded:
        layerView &&
        "maximumNumberOfFeaturesExceeded" in
          layerView
          ? layerView
              .maximumNumberOfFeaturesExceeded
          : null,
    };
  }

  async function measureZoomStage(
    stage,
  ) {
    const runtime =
      runtimeRef.current;

    if (!runtime) {
      throw new Error(
        "Die Karten wurden noch nicht initialisiert.",
      );
    }

    setStatus(
      `${stage.label}: Zoom ${stage.zoom} wird getestet ...`,
    );

    synchronizationPausedRef.current =
      true;

    try {
      const [
        featureResult,
        parquetResult,
      ] = await Promise.all([
        measureZoomForLayer({
          name: "Feature Layer",
          layerType: "feature",
          view: runtime.featureView,

          layerView:
            runtime.featureLayerView,

          zoom: stage.zoom,
        }),

        measureZoomForLayer({
          name: "GeoParquet",
          layerType: "parquet",
          view: runtime.parquetView,

          layerView:
            runtime.parquetLayerView,

          zoom: stage.zoom,
        }),
      ]);

      setCurrentZoom(stage.zoom);

      const result = {
        stageId: stage.id,
        label: stage.label,

        description:
          stage.description,

        zoom:
          stage.zoom,

        featureMs:
          featureResult.duration,

        parquetMs:
          parquetResult.duration,

        featureTimedOut:
          featureResult.timedOut,

        parquetTimedOut:
          parquetResult.timedOut,

        differenceMs:
          Math.abs(
            featureResult.duration -
              parquetResult.duration,
          ),

        featureAllFeaturesInView:
          featureResult
            .hasAllFeaturesInView,

        featureLimitExceeded:
          featureResult
            .maximumNumberOfFeaturesExceeded,

        parquetAllFeaturesInView:
          parquetResult
            .hasAllFeaturesInView,

        parquetLimitExceeded:
          parquetResult
            .maximumNumberOfFeaturesExceeded,
      };

      result.winner = getWinner({
        featureMilliseconds:
          result.featureMs,

        parquetMilliseconds:
          result.parquetMs,

        featureTimedOut:
          result.featureTimedOut,

        parquetTimedOut:
          result.parquetTimedOut,
      });

      return result;
    } finally {
      synchronizationPausedRef.current =
        false;

      synchronizationLockRef.current =
        false;
    }
  }

  async function handleDatasetChange(
    event,
  ) {
    const nextDatasetId =
      event.target.value;

    if (
      nextDatasetId ===
        selectedDatasetId ||
      running
    ) {
      return;
    }

    try {
      resetMapTimers();
      setError("");

      setStatus(
        "Datensatz wird gewechselt ...",
      );

      await removeTestLayers();

      await setBothViewpoints(
        INITIAL_VIEWPOINT.zoom,
      );

      historyRef.current = [];

      setSelectedDatasetId(
        nextDatasetId,
      );

      setResults([]);
      setHistory([]);

      setStatus(
        "Bereit für die Analyse",
      );
    } catch (cause) {
      console.error(
        "Dataset change failed:",
        cause,
      );

      setError(
        formatArcGISError(cause),
      );

      setStatus(
        "Datensatzwechsel fehlgeschlagen",
      );
    }
  }

  async function runComparison() {
    const runtime =
      runtimeRef.current;

    if (!runtime || running) {
      return;
    }

    const dataset =
      DATASETS[selectedDatasetId];

    setRunning(true);
    setError("");
    setResults([]);

    resetMapTimers();

    try {
      setStatus(
        "Vorherige Layer werden entfernt ...",
      );

      await removeTestLayers();

      await setBothViewpoints(
        INITIAL_VIEWPOINT.zoom,
      );

      const {
        featureLayer,
        parquetLayer,
      } = createTestLayers(
        dataset,
      );

      runtime.featureLayer =
        featureLayer;

      runtime.parquetLayer =
        parquetLayer;

      setStatus(
        "Deutschland: Erstmaliges Laden der Layer ...",
      );

      const [
        featureLoadResult,
        parquetLoadResult,
      ] = await Promise.all([
        loadLayerForBenchmark({
          name: "Feature Layer",
          layerType: "feature",
          view: runtime.featureView,
          map: runtime.featureMap,
          layer: featureLayer,
        }),

        loadLayerForBenchmark({
          name: "GeoParquet",
          layerType: "parquet",
          view: runtime.parquetView,
          map: runtime.parquetMap,
          layer: parquetLayer,
        }),
      ]);

      runtime.featureLayerView =
        featureLoadResult.layerView;

      runtime.parquetLayerView =
        parquetLoadResult.layerView;

      const germanyStage =
        ZOOM_STAGES[0];

      const germanyResultObject = {
        stageId:
          germanyStage.id,

        label:
          germanyStage.label,

        description:
          germanyStage.description,

        zoom:
          germanyStage.zoom,

        featureMs:
          featureLoadResult.duration,

        parquetMs:
          parquetLoadResult.duration,

        featureTimedOut:
          featureLoadResult.timedOut,

        parquetTimedOut:
          parquetLoadResult.timedOut,

        differenceMs:
          Math.abs(
            featureLoadResult.duration -
              parquetLoadResult.duration,
          ),

        featureAllFeaturesInView:
          featureLoadResult
            .hasAllFeaturesInView,

        featureLimitExceeded:
          featureLoadResult
            .maximumNumberOfFeaturesExceeded,

        parquetAllFeaturesInView:
          parquetLoadResult
            .hasAllFeaturesInView,

        parquetLimitExceeded:
          parquetLoadResult
            .maximumNumberOfFeaturesExceeded,
      };

      germanyResultObject.winner =
        getWinner({
          featureMilliseconds:
            germanyResultObject
              .featureMs,

          parquetMilliseconds:
            germanyResultObject
              .parquetMs,

          featureTimedOut:
            germanyResultObject
              .featureTimedOut,

          parquetTimedOut:
            germanyResultObject
              .parquetTimedOut,
        });

      setResults([
        germanyResultObject,
      ]);

      const regionalResult =
        await measureZoomStage(
          ZOOM_STAGES[1],
        );

      setResults([
        germanyResultObject,
        regionalResult,
      ]);

      const localResult =
        await measureZoomStage(
          ZOOM_STAGES[2],
        );

      const completedResults = [
        germanyResultObject,
        regionalResult,
        localResult,
      ];

      setResults(
        completedResults,
      );

      const existingRuns =
        historyRef.current.map(
          (entry) => entry.run,
        );

      const runNumber =
        existingRuns.length === 0
          ? 1
          : Math.max(
              ...existingRuns,
            ) + 1;

      const timestamp =
        new Date().toISOString();

      const historyEntries =
        completedResults.map(
          (stageResult) => ({
            run: runNumber,
            timestamp,

            dataset:
              dataset.label,

            totalFeatures:
              dataset.totalFeatures,

            stage:
              stageResult.label,

            zoom:
              stageResult.zoom,

            featureSeconds:
              Number(
                (
                  stageResult.featureMs /
                  1000
                ).toFixed(2),
              ),

            parquetSeconds:
              Number(
                (
                  stageResult.parquetMs /
                  1000
                ).toFixed(2),
              ),

            differenceSeconds:
              Number(
                (
                  stageResult.differenceMs /
                  1000
                ).toFixed(2),
              ),

            featureTimedOut:
              stageResult
                .featureTimedOut,

            parquetTimedOut:
              stageResult
                .parquetTimedOut,

            winner:
              stageResult.winner,

            featureAllFeaturesInView:
              stageResult
                .featureAllFeaturesInView,

            featureLimitExceeded:
              stageResult
                .featureLimitExceeded,

            parquetAllFeaturesInView:
              stageResult
                .parquetAllFeaturesInView,

            parquetLimitExceeded:
              stageResult
                .parquetLimitExceeded,
          }),
        );

      historyRef.current = [
        ...historyRef.current,
        ...historyEntries,
      ];

      setHistory(
        historyRef.current,
      );

      setStatus(
        "Analyse aller drei Zoomstufen abgeschlossen",
      );
    } catch (cause) {
      console.error(
        "Benchmark failed:",
        cause,
      );

      setError(
        formatArcGISError(cause),
      );

      setStatus(
        "Analyse fehlgeschlagen",
      );
    } finally {
      synchronizationPausedRef.current =
        false;

      synchronizationLockRef.current =
        false;

      setRunning(false);
    }
  }

  async function resetAnalysis() {
    if (running) {
      return;
    }

    try {
      resetMapTimers();

      await removeTestLayers();

      await setBothViewpoints(
        INITIAL_VIEWPOINT.zoom,
      );

      historyRef.current = [];

      setHistory([]);
      setResults([]);
      setError("");

      setStatus(
        "Bereit für die Analyse",
      );
    } catch (cause) {
      console.error(
        "Reset failed:",
        cause,
      );

      setError(
        formatArcGISError(cause),
      );
    }
  }

  function exportCsv() {
    if (history.length === 0) {
      return;
    }

    const columns =
      Object.keys(history[0]);

    function escapeCsvValue(value) {
      const text =
        String(value ?? "");

      return `"${text.replaceAll(
        '"',
        '""',
      )}"`;
    }

    const rows = history.map(
      (row) =>
        columns
          .map((column) =>
            escapeCsvValue(
              row[column],
            ),
          )
          .join(";"),
    );

    const csv = [
      columns.join(";"),
      ...rows,
    ].join("\n");

    const blob = new Blob(
      ["\uFEFF" + csv],
      {
        type:
          "text/csv;charset=utf-8",
      },
    );

    const url =
      URL.createObjectURL(blob);

    const link =
      document.createElement("a");

    link.href = url;

    link.download =
      `${selectedDatasetId}-zoom-benchmark-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;

    document.body.appendChild(link);

    link.click();
    link.remove();

    URL.revokeObjectURL(url);
  }

  function getDatasetSubtitle() {
    return `${formatNumber(
      selectedDataset.totalFeatures,
    )} Features · Zoom ${currentZoom}`;
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-gradient-to-br from-slate-50 via-blue-50/60 to-violet-50 text-slate-900">
      <ParquetInfoModal
        isOpen={showInfoModal}
        onClose={() =>
          setShowInfoModal(false)
        }
      />

      <header className="sticky top-0 z-40 border-b border-white/60 bg-white/80 px-4 py-3 shadow-sm backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-violet-500 to-cyan-400 opacity-40 blur-md" />

              <div className="relative rounded-2xl bg-gradient-to-br from-violet-600 via-blue-600 to-cyan-500 p-2.5 text-white shadow-lg">
                <MapIcon className="h-5 w-5" />
              </div>
            </div>

            <div>
              <h1 className="text-lg font-bold">
                Feature Layer vs. GeoParquet
              </h1>

              <p className="text-xs text-slate-500">
                Lade- und Zoom-Performance großer Deutschland-Datensätze
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50 to-violet-50 px-3 py-2 shadow-sm transition hover:shadow-md">
              <span className="text-xs font-medium text-slate-500">
                Datensatz
              </span>

              <select
                value={
                  selectedDatasetId
                }
                onChange={
                  handleDatasetChange
                }
                disabled={running}
                className="bg-transparent text-sm font-semibold text-slate-900 outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="haltestellen">
                  Haltestellen
                </option>

                <option value="radwege">
                  Radwege
                </option>
              </select>
            </label>

            <button
              type="button"
              onClick={() =>
                setShowInfoModal(true)
              }
              className="flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-semibold text-violet-700 transition hover:-translate-y-0.5 hover:bg-violet-100"
            >
              <Info className="h-4 w-4" />
              Was ist Parquet?
            </button>

            <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              Zoom: {currentZoom}
            </div>

            <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              Zeitlimit: 30 s
            </div>

            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                running
                  ? "bg-amber-100 text-amber-800"
                  : ready
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-200 text-slate-700"
              }`}
            >
              {status}
            </span>

            <button
              type="button"
              onClick={
                resetAnalysis
              }
              disabled={
                !ready || running
              }
              className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              Zurücksetzen
            </button>

            <button
              type="button"
              onClick={
                runComparison
              }
              disabled={
                !ready || running
              }
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 via-blue-600 to-cyan-500 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />

              {running
                ? "Analyse läuft"
                : "3 Zoomstufen analysieren"}
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-[1800px] p-4 sm:p-6">
        <div className="pointer-events-none absolute left-0 top-20 -z-10 h-72 w-72 rounded-full bg-violet-300/20 blur-3xl" />

        <div className="pointer-events-none absolute right-0 top-96 -z-10 h-80 w-80 rounded-full bg-cyan-300/20 blur-3xl" />

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50/90 p-3 text-sm text-red-800 shadow-lg backdrop-blur">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section className="mb-4 overflow-hidden rounded-[1.75rem] border border-white/70 bg-gradient-to-r from-blue-600 via-violet-600 to-cyan-500 p-[1px] shadow-xl shadow-blue-900/10">
          <div className="rounded-[calc(1.75rem-1px)] bg-white/92 p-5 backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-semibold text-slate-950">
                  {selectedDataset.description}
                </p>

                <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600">
                  Verglichen werden dieselben Geodaten als
                  klassischer ArcGIS Feature Layer und als
                  Parquet Feature Layer. Die Analyse misst
                  das erstmalige Laden sowie die
                  Aktualisierung bei zwei weiteren
                  Zoomstufen.
                </p>
              </div>

              <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-violet-50 px-6 py-3 text-center shadow-sm">
                <p className="text-2xl font-bold text-blue-700">
                  {formatNumber(
                    selectedDataset
                      .totalFeatures,
                  )}
                </p>

                <p className="text-xs font-medium text-slate-500">
                  Features im Test
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mb-4 grid gap-3 md:grid-cols-3">
          <StatCard
            title={`${selectedDataset.label} · Feature Layer`}
            value={
              !germanyResult
                ? "–"
                : germanyResult
                      .featureTimedOut
                  ? "> 30,00 s"
                  : `${formatSeconds(
                      germanyResult
                        .featureMs,
                    )} s`
            }
            subtitle={
              !germanyResult
                ? "Erstmaliges Laden bei Zoom 5"
                : getCompletenessText({
                    timedOut:
                      germanyResult
                        .featureTimedOut,

                    hasAllFeaturesInView:
                      germanyResult
                        .featureAllFeaturesInView,

                    maximumNumberOfFeaturesExceeded:
                      germanyResult
                        .featureLimitExceeded,
                  })
            }
            active={running}
            winner={
              germanyWinnerKey ===
              "feature"
            }
            warning={
              germanyResult
                ?.featureTimedOut
            }
            color="blue"
          />

          <StatCard
            title={`${selectedDataset.label} · GeoParquet`}
            value={
              !germanyResult
                ? "–"
                : germanyResult
                      .parquetTimedOut
                  ? "> 30,00 s"
                  : `${formatSeconds(
                      germanyResult
                        .parquetMs,
                    )} s`
            }
            subtitle={
              !germanyResult
                ? "Erstmaliges Laden bei Zoom 5"
                : getCompletenessText({
                    timedOut:
                      germanyResult
                        .parquetTimedOut,

                    hasAllFeaturesInView:
                      germanyResult
                        .parquetAllFeaturesInView,

                    maximumNumberOfFeaturesExceeded:
                      germanyResult
                        .parquetLimitExceeded,
                  })
            }
            active={running}
            winner={
              germanyWinnerKey ===
              "parquet"
            }
            warning={
              germanyResult
                ?.parquetTimedOut
            }
            color="orange"
          />

          <StatCard
            title="Ergebnis · Deutschland"
            value={
              !germanyResult
                ? "–"
                : germanyResult
                      .featureTimedOut ||
                    germanyResult
                      .parquetTimedOut
                  ? "Zeitlimit erreicht"
                  : `${formatSeconds(
                      germanyResult
                        .differenceMs,
                    )} s`
            }
            subtitle={
              !germanyResult
                ? "Noch keine Analyse"
                : germanyResult.winner ===
                    "Gleichstand"
                  ? "Gleichstand"
                  : `${germanyResult.winner} schneller`
            }
            color="violet"
          />
        </section>

        <section className="grid h-[58vh] min-h-[470px] gap-4 lg:grid-cols-2">
          <div className="group relative overflow-hidden rounded-[1.75rem] border border-blue-200/70 bg-white shadow-xl shadow-blue-900/10 ring-1 ring-white transition hover:-translate-y-0.5 hover:shadow-2xl">
            <MapLabel
              title={`${selectedDataset.label} · Feature Layer`}
              subtitle={
                getDatasetSubtitle()
              }
              color="blue"
            />

            <div
              ref={
                featureContainerRef
              }
              className="h-full w-full"
            />

            <MapTimer
              timer={featureTimer}
              color="blue"
            />
          </div>

          <div className="group relative overflow-hidden rounded-[1.75rem] border border-orange-200/70 bg-white shadow-xl shadow-orange-900/10 ring-1 ring-white transition hover:-translate-y-0.5 hover:shadow-2xl">
            <MapLabel
              title={`${selectedDataset.label} · GeoParquet`}
              subtitle={
                getDatasetSubtitle()
              }
              color="orange"
            />

            <div
              ref={
                parquetContainerRef
              }
              className="h-full w-full"
            />

            <MapTimer
              timer={parquetTimer}
              color="orange"
            />
          </div>
        </section>

        <section className="mt-6">
          <div className="mb-3">
            <h2 className="text-lg font-bold text-slate-900">
              Verhalten beim Zoomen
            </h2>

            <p className="text-sm text-slate-500">
              Vergleich der Lade- und
              Aktualisierungszeiten in drei
              Maßstabsstufen.
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            {results.length === 0
              ? ZOOM_STAGES.map(
                  (stage) => (
                    <div
                      key={stage.id}
                      className="rounded-[1.5rem] border border-dashed border-slate-300 bg-white/70 p-4 shadow-sm backdrop-blur"
                    >
                      <p className="font-semibold text-slate-500">
                        {stage.label}
                      </p>

                      <p className="mt-1 text-xs text-slate-400">
                        Zoom {stage.zoom} ·{" "}
                        {stage.description}
                      </p>

                      <p className="mt-5 text-sm text-slate-400">
                        Noch nicht analysiert
                      </p>
                    </div>
                  ),
                )
              : results.map(
                  (stageResult) => (
                    <ZoomResultCard
                      key={
                        stageResult
                          .stageId
                      }
                      result={
                        stageResult
                      }
                    />
                  ),
                )}
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/85 shadow-xl shadow-slate-900/5 backdrop-blur">
          <div className="flex items-center justify-between border-b border-slate-200/80 p-4">
            <div className="flex items-center gap-2">
              <div className="rounded-xl bg-blue-100 p-2 text-blue-600">
                <Timer className="h-5 w-5" />
              </div>

              <div>
                <h2 className="font-bold">
                  Messverlauf
                </h2>

                <p className="text-xs text-slate-500">
                  Ergebnisse der aktuellen Sitzung
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={exportCsv}
              disabled={
                history.length === 0
              }
              className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              CSV exportieren
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left text-sm">
              <thead className="bg-slate-50/80 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">
                    Lauf
                  </th>

                  <th className="px-4 py-3">
                    Datensatz
                  </th>

                  <th className="px-4 py-3">
                    Teststufe
                  </th>

                  <th className="px-4 py-3">
                    Zoom
                  </th>

                  <th className="px-4 py-3">
                    Feature Layer
                  </th>

                  <th className="px-4 py-3">
                    GeoParquet
                  </th>

                  <th className="px-4 py-3">
                    Differenz
                  </th>

                  <th className="px-4 py-3">
                    Gewinner
                  </th>
                </tr>
              </thead>

              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-10 text-center text-slate-400"
                    >
                      Noch keine Analysen vorhanden
                    </td>
                  </tr>
                ) : (
                  history
                    .slice()
                    .reverse()
                    .map(
                      (
                        row,
                        index,
                      ) => (
                        <tr
                          key={`${row.timestamp}-${row.dataset}-${row.stage}-${index}`}
                          className="border-t border-slate-100 transition hover:bg-blue-50/40"
                        >
                          <td className="px-4 py-3 font-medium">
                            {row.run}
                          </td>

                          <td className="px-4 py-3">
                            {row.dataset}
                          </td>

                          <td className="px-4 py-3">
                            {row.stage}
                          </td>

                          <td className="px-4 py-3">
                            {row.zoom}
                          </td>

                          <td className="px-4 py-3">
                            {row.featureTimedOut
                              ? "> 30,00 s"
                              : `${new Intl.NumberFormat(
                                  "de-DE",
                                  {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  },
                                ).format(
                                  row.featureSeconds,
                                )} s`}
                          </td>

                          <td className="px-4 py-3">
                            {row.parquetTimedOut
                              ? "> 30,00 s"
                              : `${new Intl.NumberFormat(
                                  "de-DE",
                                  {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  },
                                ).format(
                                  row.parquetSeconds,
                                )} s`}
                          </td>

                          <td className="px-4 py-3">
                            {row.featureTimedOut ||
                            row.parquetTimedOut
                              ? "Zeitlimit"
                              : `${new Intl.NumberFormat(
                                  "de-DE",
                                  {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  },
                                ).format(
                                  row.differenceSeconds,
                                )} s`}
                          </td>

                          <td className="px-4 py-3">
                            <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">
                              {row.winner}
                            </span>
                          </td>
                        </tr>
                      ),
                    )
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}