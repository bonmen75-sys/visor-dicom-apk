import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, Link as LinkIcon, Sun, Contrast, ZoomIn, Move, Ruler,
  RotateCw, FlipHorizontal, RefreshCw, Play, Pause, Share2,
  FolderDown, Trash2, CheckCircle2, Wifi, WifiOff, Plus, X,
  FileText, Sliders, ChevronLeft, ChevronRight, Download, ShieldCheck
} from 'lucide-react';

// ==========================================
// 1. BASE DE DATOS OFFLINE (IndexedDB)
// ==========================================
const DB_NAME = 'MedViewDicomOfflineDB';
const DB_VERSION = 1;
const STORE_NAME = 'studies';

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveStudyToDB(studyRecord) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(studyRecord);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllStudiesFromDB() {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteStudyFromDB(id) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ==========================================
// 2. PARSER BINARIO DICOM (8 / 16 BITS + HU)
// ==========================================
function parseDicomArrayBuffer(buffer) {
  const dataView = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // Verificar encabezado DICM en byte 128
  let offset = 128;
  let hasPreamble = false;
  if (buffer.byteLength > 132) {
    const magic = String.fromCharCode(uint8[128], uint8[129], uint8[130], uint8[131]);
    if (magic === 'DICM') {
      hasPreamble = true;
      offset = 132;
    }
  }
  if (!hasPreamble) offset = 0;

  let rows = 512;
  let cols = 512;
  let bitsAllocated = 16;
  let pixelRepresentation = 0; // 0 = unsigned, 1 = signed
  let rescaleSlope = 1;
  let rescaleIntercept = 0;
  let windowCenter = null;
  let windowWidth = null;
  let pixelSpacing = [1, 1];
  let photometric = 'MONOCHROME2';
  let patientName = 'PACIENTE ANÓNIMO';
  let patientId = 'N/A';
  let studyDate = 'Sin fecha';
  let modality = 'CT';
  let studyDescription = 'Estudio DICOM';
  let instanceNumber = 1;
  let pixelDataOffset = null;
  let pixelDataLength = null;

  const explicitVRs = new Set([
    'AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT',
    'OB', 'OD', 'OF', 'OL', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'TM',
    'UC', 'UI', 'UL', 'UN', 'UR', 'US', 'UT'
  ]);
  const longVRs = new Set(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);

  const readString = (start, len) => {
    let str = '';
    const end = Math.min(start + len, buffer.byteLength);
    for (let i = start; i < end; i++) {
      const code = uint8[i];
      if (code === 0) break;
      str += String.fromCharCode(code);
    }
    return str.trim();
  };

  while (offset + 8 <= buffer.byteLength) {
    const group = dataView.getUint16(offset, true);
    const element = dataView.getUint16(offset + 2, true);
    offset += 4;

    if (group === 0xFFFE) {
      const itemLen = dataView.getUint32(offset, true);
      offset += 4;
      if (itemLen !== 0xFFFFFFFF && offset + itemLen <= buffer.byteLength) {
        offset += itemLen;
      }
      continue;
    }

    const vrCandidate = String.fromCharCode(uint8[offset], uint8[offset + 1]);
    let vr = '';
    let length = 0;

    if (explicitVRs.has(vrCandidate)) {
      vr = vrCandidate;
      if (longVRs.has(vr)) {
        if (offset + 8 > buffer.byteLength) break;
        length = dataView.getUint32(offset + 4, true);
        offset += 8;
      } else {
        length = dataView.getUint16(offset + 2, true);
        offset += 4;
      }
    } else {
      length = dataView.getUint32(offset, true);
      offset += 4;
    }

    if (group === 0x7FE0 && element === 0x0010) {
      pixelDataOffset = offset;
      pixelDataLength = length === 0xFFFFFFFF ? buffer.byteLength - offset : length;
      break;
    }

    if (length === 0xFFFFFFFF) {
      continue;
    }

    if (offset + length > buffer.byteLength) break;

    // Extraer etiquetas relevantes
    if (group === 0x0010 && element === 0x0010) {
      patientName = readString(offset, length).replace(/\^+/g, ' ') || patientName;
    } else if (group === 0x0010 && element === 0x0020) {
      patientId = readString(offset, length) || patientId;
    } else if (group === 0x0008 && element === 0x0020) {
      const rawDate = readString(offset, length);
      if (rawDate.length === 8) {
        studyDate = `${rawDate.slice(6, 8)}/${rawDate.slice(4, 6)}/${rawDate.slice(0, 4)}`;
      }
    } else if (group === 0x0008 && element === 0x0060) {
      modality = readString(offset, length) || modality;
    } else if (group === 0x0008 && element === 0x1030) {
      studyDescription = readString(offset, length) || studyDescription;
    } else if (group === 0x0020 && element === 0x0013) {
      instanceNumber = parseInt(readString(offset, length), 10) || 1;
    } else if (group === 0x0028 && element === 0x0004) {
      photometric = readString(offset, length) || photometric;
    } else if (group === 0x0028 && element === 0x0010 && length >= 2) {
      rows = dataView.getUint16(offset, true);
    } else if (group === 0x0028 && element === 0x0011 && length >= 2) {
      cols = dataView.getUint16(offset, true);
    } else if (group === 0x0028 && element === 0x0030) {
      const parts = readString(offset, length).split('\\').map(Number);
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        pixelSpacing = [parts[0], parts[1]];
      }
    } else if (group === 0x0028 && element === 0x0100 && length >= 2) {
      bitsAllocated = dataView.getUint16(offset, true);
    } else if (group === 0x0028 && element === 0x0103 && length >= 2) {
      pixelRepresentation = dataView.getUint16(offset, true);
    } else if (group === 0x0028 && element === 0x1050) {
      const wc = parseFloat(readString(offset, length).split('\\')[0]);
      if (!isNaN(wc)) windowCenter = wc;
    } else if (group === 0x0028 && element === 0x1051) {
      const ww = parseFloat(readString(offset, length).split('\\')[0]);
      if (!isNaN(ww)) windowWidth = ww;
    } else if (group === 0x0028 && element === 0x1052) {
      const ri = parseFloat(readString(offset, length));
      if (!isNaN(ri)) rescaleIntercept = ri;
    } else if (group === 0x0028 && element === 0x1053) {
      const rs = parseFloat(readString(offset, length));
      if (!isNaN(rs)) rescaleSlope = rs;
    }

    offset += length;
  }

  if (pixelDataOffset === null) {
    throw new Error('No se encontró PixelData válido en el archivo DICOM.');
  }

  const totalPixels = rows * cols;
  const huData = new Float32Array(totalPixels);
  let minVal = Infinity;
  let maxVal = -Infinity;

  if (bitsAllocated === 8) {
    for (let i = 0; i < totalPixels && pixelDataOffset + i < buffer.byteLength; i++) {
      const raw = uint8[pixelDataOffset + i];
      const hu = raw * rescaleSlope + rescaleIntercept;
      huData[i] = hu;
      if (hu < minVal) minVal = hu;
      if (hu > maxVal) maxVal = hu;
    }
  } else {
    for (let i = 0; i < totalPixels && pixelDataOffset + i * 2 + 1 < buffer.byteLength; i++) {
      const raw = pixelRepresentation === 1
        ? dataView.getInt16(pixelDataOffset + i * 2, true)
        : dataView.getUint16(pixelDataOffset + i * 2, true);
      const hu = raw * rescaleSlope + rescaleIntercept;
      huData[i] = hu;
      if (hu < minVal) minVal = hu;
      if (hu > maxVal) maxVal = hu;
    }
  }

  if (windowCenter === null || windowWidth === null) {
    windowCenter = (maxVal + minVal) / 2;
    windowWidth = Math.max(1, maxVal - minVal);
  }

  return {
    rows,
    cols,
    huData,
    minVal,
    maxVal,
    defaultWindowCenter: windowCenter,
    defaultWindowWidth: windowWidth,
    pixelSpacing,
    invert: photometric === 'MONOCHROME1',
    metadata: {
      patientName,
      patientId,
      studyDate,
      modality,
      studyDescription,
      instanceNumber,
    },
  };
}

// ==========================================
// 3. GENERADOR DE ESTUDIO DE DEMOSTRACIÓN (TC TÓRAX)
// ==========================================
function generateDemoStudy() {
  const slices = [];
  const rows = 256;
  const cols = 256;
  const totalSlices = 10;

  for (let s = 0; s < totalSlices; s++) {
    const huData = new Float32Array(rows * cols);
    const zFactor = (s - totalSlices / 2) / (totalSlices / 2); // -1 a 1

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        const nx = (x - cols / 2) / (cols / 2);
        const ny = (y - rows / 2) / (rows / 2);

        // Aire exterior (-1000 HU)
        let hu = -1000;

        // Contorno torácico (elipse tejido blando ~45 HU)
        const bodyDist = (nx * nx) / 0.72 + (ny * ny) / 0.48;
        if (bodyDist < 1.0) {
          hu = 45 + (Math.sin(x * 0.2) * 5);

          // Grasa subcutánea (-90 HU)
          if (bodyDist > 0.85) {
            hu = -90;
          }

          // Pulmón derecho e izquierdo (-780 HU)
          const lungScale = 1 - Math.abs(zFactor) * 0.25;
          const rLung = ((nx + 0.34) ** 2) / (0.16 * lungScale) + ((ny + 0.02) ** 2) / (0.24 * lungScale);
          const lLung = ((nx - 0.34) ** 2) / (0.16 * lungScale) + ((ny + 0.02) ** 2) / (0.24 * lungScale);

          if (rLung < 1.0 || lLung < 1.0) {
            hu = -780 + Math.cos(x * 0.35) * Math.sin(y * 0.35) * 45;
            // Nódulo pulmonar simulado en cortes centrales
            if (s >= 4 && s <= 6) {
              const nodDist = (nx - 0.32) ** 2 + (ny - 0.05) ** 2;
              if (nodDist < 0.0025) hu = 35;
            }
          }

          // Corazón / Mediastino (60 HU + contraste 180 HU)
          const heartDist = ((nx - 0.06) ** 2) / 0.045 + ((ny + 0.08) ** 2) / 0.055;
          if (heartDist < 1.0) {
            hu = 65;
            if (heartDist < 0.45) hu = 190;
          }

          // Aorta descendente (210 HU)
          const aortaDist = ((nx - 0.08) ** 2) + ((ny - 0.22) ** 2);
          if (aortaDist < 0.004) hu = 210;

          // Columna vertebral (Hueso cortical ~850 HU)
          const spineDist = ((nx) ** 2) / 0.015 + ((ny - 0.32) ** 2) / 0.012;
          if (spineDist < 1.0) {
            hu = 850;
            if (spineDist < 0.35) hu = 30; // Canal medular
          }

          // Esternón
          const sternumDist = ((nx) ** 2) / 0.012 + ((ny + 0.42) ** 2) / 0.004;
          if (sternumDist < 1.0) hu = 720;
        }

        huData[idx] = hu;
      }
    }

    slices.push({
      rows,
      cols,
      huData,
      minVal: -1000,
      maxVal: 900,
      defaultWindowCenter: -600,
      defaultWindowWidth: 1500,
      pixelSpacing: [0.78, 0.78],
      invert: false,
      metadata: {
        patientName: 'DEMO ^ PACIENTE EJEMPLO',
        patientId: 'MED-2026-001',
        studyDate: '24/11/2026',
        modality: 'CT',
        studyDescription: 'TC DE TÓRAX SIMPLE Y CONTRASTADA (DEMO)',
        instanceNumber: s + 1,
      },
    });
  }
  return slices;
}

// ==========================================
// 4. COMPONENTE PRINCIPAL DE LA APLICACIÓN
// ==========================================
const WINDOW_PRESETS = [
  { name: 'Por defecto', wc: null, ww: null },
  { name: 'Pulmón', wc: -600, ww: 1500 },
  { name: 'Tejido Blando', wc: 50, ww: 400 },
  { name: 'Hueso', wc: 400, ww: 1800 },
  { name: 'Cerebro', wc: 40, ww: 80 },
];

export default function DicomViewerApp() {
  // Estado de la serie actual
  const [slices, setSlices] = useState([]);
  const [currentSliceIdx, setCurrentSliceIdx] = useState(0);
  const [rawBuffers, setRawBuffers] = useState([]); // Para guardar en IndexedDB

  // Estado de renderizado y cámara
  const [windowCenter, setWindowCenter] = useState(-600);
  const [windowWidth, setWindowWidth] = useState(1500);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [invertColors, setInvertColors] = useState(false);

  // Herramientas e interacción
  const [activeTool, setActiveTool] = useState('wl'); // 'wl' | 'pan' | 'zoom' | 'measure'
  const [measurements, setMeasurements] = useState([]);
  const [activeMeasure, setActiveMeasure] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // URLs, Descarga Offline y Biblioteca
  const [urlInput, setUrlInput] = useState('');
  const [batchUrlsText, setBatchUrlsText] = useState('');
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showOfflineModal, setShowOfflineModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [savedStudies, setSavedStudies] = useState([]);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [statusMessage, setStatusMessage] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [sharePin, setSharePin] = useState('');
  const [generatedLink, setGeneratedLink] = useState('');

  const canvasRef = useRef(null);
  const offscreenCanvasRef = useRef(null);
  const dragStateRef = useRef({ isDragging: false, startX: 0, startY: 0, initialWC: 0, initialWW: 0, initialPanX: 0, initialPanY: 0, initialZoom: 1 });
  const pinchStateRef = useRef({ active: false, initialDist: 0, initialZoom: 1 });
  const fileInputRef = useRef(null);

  const currentSlice = slices[currentSliceIdx] || null;

  // Monitorear estado de conexión (Online / Offline)
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    refreshSavedStudies();
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Cargar estudio demo o parámetro ?url= al iniciar
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryUrl = params.get('url');
    if (queryUrl) {
      setUrlInput(queryUrl);
      loadFromUrls([queryUrl], true);
    } else {
      const demo = generateDemoStudy();
      setSlices(demo);
      setCurrentSliceIdx(0);
      setWindowCenter(demo[0].defaultWindowCenter);
      setWindowWidth(demo[0].defaultWindowWidth);
    }
  }, []);

  const refreshSavedStudies = async () => {
    try {
      const list = await getAllStudiesFromDB();
      setSavedStudies(list.sort((a, b) => b.savedAt - a.savedAt));
    } catch (e) {
      console.error('Error leyendo IndexedDB:', e);
    }
  };

  // Reproducción Cine Loop
  useEffect(() => {
    if (!isPlaying || slices.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentSliceIdx((prev) => (prev + 1) % slices.length);
    }, 120);
    return () => clearInterval(interval);
  }, [isPlaying, slices.length]);

  // ==========================================
  // RENDERIZADO EN CANVAS
  // ==========================================
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentSlice) return;

    const ctx = canvas.getContext('2d');
    const { rows, cols, huData, invert } = currentSlice;

    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }
    const offscreen = offscreenCanvasRef.current;
    if (offscreen.width !== cols || offscreen.height !== rows) {
      offscreen.width = cols;
      offscreen.height = rows;
    }

    const offCtx = offscreen.getContext('2d');
    const imgData = offCtx.createImageData(cols, rows);
    const data = imgData.data;

    const minHU = windowCenter - windowWidth / 2;
    const maxHU = windowCenter + windowWidth / 2;
    const range = Math.max(1, maxHU - minHU);
    const shouldInvert = invert !== invertColors;

    for (let i = 0; i < huData.length; i++) {
      let val = ((huData[i] - minHU) / range) * 255;
      if (val < 0) val = 0;
      else if (val > 255) val = 255;
      if (shouldInvert) val = 255 - val;

      const p = i * 4;
      data[p] = val;
      data[p + 1] = val;
      data[p + 2] = val;
      data[p + 3] = 255;
    }
    offCtx.putImageData(imgData, 0, 0);

    // Ajustar tamaño del canvas visible al contenedor
    const rect = canvas.parentElement.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width / 2 + pan.x, canvas.height / 2 + pan.y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(flipH ? -zoom : zoom, zoom);

    const baseScale = Math.min((canvas.width * 0.88) / cols, (canvas.height * 0.88) / rows);
    const drawW = cols * baseScale;
    const drawH = rows * baseScale;

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offscreen, -drawW / 2, -drawH / 2, drawW, drawH);

    // Dibujar mediciones en milímetros
    const sliceMeasures = measurements.filter((m) => m.sliceIdx === currentSliceIdx);
    const allMeasures = activeMeasure ? [...sliceMeasures, activeMeasure] : sliceMeasures;

    ctx.lineWidth = 2 / zoom;
    ctx.font = `${Math.max(11, 13 / zoom)}px sans-serif`;

    allMeasures.forEach((m) => {
      ctx.strokeStyle = '#38bdf8';
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      ctx.stroke();

      // Puntos extremos
      ctx.beginPath();
      ctx.arc(m.x1, m.y1, 3.5 / zoom, 0, Math.PI * 2);
      ctx.arc(m.x2, m.y2, 3.5 / zoom, 0, Math.PI * 2);
      ctx.fill();

      // Cálculo distancia real en mm
      const dxPx = (m.x2 - m.x1) / baseScale;
      const dyPx = (m.y2 - m.y1) / baseScale;
      const distMm = Math.sqrt(
        (dxPx * currentSlice.pixelSpacing[1]) ** 2 +
        (dyPx * currentSlice.pixelSpacing[0]) ** 2
      );

      const label = `${distMm.toFixed(1)} mm`;
      ctx.fillStyle = 'rgba(2, 6, 23, 0.8)';
      ctx.fillRect(m.x2 + 6 / zoom, m.y2 - 14 / zoom, (label.length * 7 + 8) / zoom, 18 / zoom);
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(label, m.x2 + 10 / zoom, m.y2);
    });

    ctx.restore();
  }, [currentSlice, windowCenter, windowWidth, zoom, pan, rotation, flipH, invertColors, measurements, activeMeasure, currentSliceIdx]);

  useEffect(() => {
    renderCanvas();
    const handleResize = () => renderCanvas();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderCanvas]);

  // ==========================================
  // CARGA DE URLS, ARCHIVOS LOCALES Y OFFLINE
  // ==========================================
  const processBuffers = (buffers, sourceLabel = '') => {
    const parsedSlices = [];
    for (const buf of buffers) {
      parsedSlices.push(parseDicomArrayBuffer(buf));
    }
    parsedSlices.sort((a, b) => a.metadata.instanceNumber - b.metadata.instanceNumber);

    setSlices(parsedSlices);
    setRawBuffers(buffers);
    setCurrentSliceIdx(0);
    setWindowCenter(parsedSlices[0].defaultWindowCenter);
    setWindowWidth(parsedSlices[0].defaultWindowWidth);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setFlipH(false);
    setMeasurements([]);
    if (sourceLabel) {
      setStatusMessage({ type: 'success', text: sourceLabel });
    }
  };

  const loadFromUrls = async (urls, autoSaveOffline = false) => {
    const cleanUrls = urls.map((u) => u.trim()).filter(Boolean);
    if (cleanUrls.length === 0) return;

    try {
      setDownloadProgress({ current: 0, total: cleanUrls.length });
      const fetchedBuffers = [];

      for (let i = 0; i < cleanUrls.length; i++) {
        setDownloadProgress({ current: i + 1, total: cleanUrls.length });
        const response = await fetch(cleanUrls[i]);
        if (!response.ok) {
          throw new Error(`Error HTTP ${response.status} al descargar el corte ${i + 1}`);
        }
        const buf = await response.arrayBuffer();
        fetchedBuffers.push(buf);
      }

      processBuffers(fetchedBuffers, `Estudio cargado (${fetchedBuffers.length} corte(s))`);

      if (autoSaveOffline) {
        const firstSlice = parseDicomArrayBuffer(fetchedBuffers[0]);
        const totalBytes = fetchedBuffers.reduce((acc, b) => acc + b.byteLength, 0);
        await saveStudyToDB({
          id: `study_${Date.now()}`,
          patientName: firstSlice.metadata.patientName,
          modality: firstSlice.metadata.modality,
          studyDate: firstSlice.metadata.studyDate,
          studyDescription: firstSlice.metadata.studyDescription,
          sliceCount: fetchedBuffers.length,
          sizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
          savedAt: Date.now(),
          buffers: fetchedBuffers,
        });
        await refreshSavedStudies();
        setStatusMessage({
          type: 'success',
          text: 'Estudio descargado y guardado en la memoria de tu tablet para ver sin Internet.',
        });
      }
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: `${err.message}. Verifica que la liga apunte directo a un archivo .dcm y permita CORS.`,
      });
    } finally {
      setDownloadProgress(null);
    }
  };

  const handleSaveCurrentStudyOffline = async () => {
    if (!currentSlice) return;
    try {
      if (rawBuffers.length === 0) {
        setStatusMessage({
          type: 'error',
          text: 'Este es el estudio de demostración. Carga una liga DICOM o un archivo .dcm para guardarlo offline.',
        });
        return;
      }
      const totalBytes = rawBuffers.reduce((acc, b) => acc + b.byteLength, 0);
      await saveStudyToDB({
        id: `study_${Date.now()}`,
        patientName: currentSlice.metadata.patientName,
        modality: currentSlice.metadata.modality,
        studyDate: currentSlice.metadata.studyDate,
        studyDescription: currentSlice.metadata.studyDescription,
        sliceCount: rawBuffers.length,
        sizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
        savedAt: Date.now(),
        buffers: rawBuffers,
      });
      await refreshSavedStudies();
      setStatusMessage({
        type: 'success',
        text: `Guardado en tu dispositivo (${(totalBytes / (1024 * 1024)).toFixed(2)} MB). Disponible sin Internet.`,
      });
    } catch (err) {
      setStatusMessage({ type: 'error', text: 'No se pudo guardar en la memoria local.' });
    }
  };

  const handleOpenSavedStudy = (study) => {
    try {
      processBuffers(study.buffers, `Abierto desde memoria offline: ${study.patientName}`);
      setShowOfflineModal(false);
    } catch (e) {
      setStatusMessage({ type: 'error', text: 'Error al abrir el estudio guardado.' });
    }
  };

  const handleDeleteSavedStudy = async (id) => {
    await deleteStudyFromDB(id);
    await refreshSavedStudies();
  };

  const handleLocalFiles = async (fileList) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    try {
      const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
      processBuffers(buffers, `${files.length} archivo(s) DICOM cargados localmente`);
    } catch (err) {
      setStatusMessage({ type: 'error', text: 'Uno o más archivos no tienen formato DICOM válido.' });
    }
  };

  // ==========================================
  // EVENTOS DE RATÓN Y GESTOS TÁCTILES (TABLET)
  // ==========================================
  const getCanvasLocalCoords = (clientX, clientY) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const cx = clientX - rect.left - canvas.width / 2 - pan.x;
    const cy = clientY - rect.top - canvas.height / 2 - pan.y;
    const rad = (-rotation * Math.PI) / 180;
    const rx = cx * Math.cos(rad) - cy * Math.sin(rad);
    const ry = cx * Math.sin(rad) + cy * Math.cos(rad);
    return {
      x: (flipH ? -rx : rx) / zoom,
      y: ry / zoom,
    };
  };

  const handlePointerDown = (clientX, clientY) => {
    if (activeTool === 'measure') {
      const pt = getCanvasLocalCoords(clientX, clientY);
      setActiveMeasure({ sliceIdx: currentSliceIdx, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
      return;
    }
    dragStateRef.current = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      initialWC: windowCenter,
      initialWW: windowWidth,
      initialPanX: pan.x,
      initialPanY: pan.y,
      initialZoom: zoom,
    };
  };

  const handlePointerMove = (clientX, clientY) => {
    if (activeTool === 'measure' && activeMeasure) {
      const pt = getCanvasLocalCoords(clientX, clientY);
      setActiveMeasure((prev) => ({ ...prev, x2: pt.x, y2: pt.y }));
      return;
    }
    if (!dragStateRef.current.isDragging) return;
    const dx = clientX - dragStateRef.current.startX;
    const dy = clientY - dragStateRef.current.startY;

    if (activeTool === 'wl') {
      setWindowWidth(Math.max(1, Math.round(dragStateRef.current.initialWW + dx * 2.5)));
      setWindowCenter(Math.round(dragStateRef.current.initialWC + dy * 2.5));
    } else if (activeTool === 'pan') {
      setPan({
        x: dragStateRef.current.initialPanX + dx,
        y: dragStateRef.current.initialPanY + dy,
      });
    } else if (activeTool === 'zoom') {
      const factor = 1 - dy * 0.005;
      setZoom(Math.min(8, Math.max(0.25, dragStateRef.current.initialZoom * factor)));
    }
  };

  const handlePointerUp = () => {
    if (activeTool === 'measure' && activeMeasure) {
      setMeasurements((prev) => [...prev, activeMeasure]);
      setActiveMeasure(null);
    }
    dragStateRef.current.isDragging = false;
  };

  // Gestos táctiles (1 dedo herramienta, 2 dedos Pinch-to-Zoom)
  const handleTouchStart = (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStateRef.current = {
        active: true,
        initialDist: Math.hypot(dx, dy),
        initialZoom: zoom,
      };
      dragStateRef.current.isDragging = false;
    } else if (e.touches.length === 1) {
      handlePointerDown(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 2 && pinchStateRef.current.active) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / Math.max(1, pinchStateRef.current.initialDist);
      setZoom(Math.min(8, Math.max(0.25, pinchStateRef.current.initialZoom * scale)));
    } else if (e.touches.length === 1) {
      handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

  const handleTouchEnd = () => {
    pinchStateRef.current.active = false;
    handlePointerUp();
  };

  const handleWheel = (e) => {
    if (slices.length > 1) {
      const delta = e.deltaY > 0 ? 1 : -1;
      setCurrentSliceIdx((prev) => (prev + delta + slices.length) % slices.length);
    } else {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setZoom((z) => Math.min(8, Math.max(0.25, z * factor)));
    }
  };

  const generateShareableLink = () => {
    const base = window.location.origin + window.location.pathname;
    const targetUrl = urlInput.trim() || 'https://ejemplo-pacs.org/estudios/torax.dcm';
    const token = Math.random().toString(36).substring(2, 10).toUpperCase();
    const link = `${base}?url=${encodeURIComponent(targetUrl)}&token=${token}${sharePin ? `&pin=${sharePin}` : ''}`;
    setGeneratedLink(link);
  };

  return (
    <div
      className="flex flex-col h-screen bg-slate-950 text-slate-100 select-none overflow-hidden font-sans"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) handleLocalFiles(e.dataTransfer.files);
      }}
    >
      {/* BARRA SUPERIOR: LIGA DICOM + ESTADO OFFLINE */}
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-sky-500/20 border border-sky-500/40 flex items-center justify-center text-sky-400 font-bold">
            Rx
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">MedView DICOM</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              {isOnline ? (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                  <Wifi className="w-3 h-3" /> En línea
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] text-amber-400 font-medium">
                  <WifiOff className="w-3 h-3" /> Modo Sin Internet
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Barra para pegar liga DICOM */}
        <div className="flex items-center flex-1 max-w-xl gap-1.5">
          <div className="relative flex-1">
            <LinkIcon className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Pega aquí la liga del archivo .dcm..."
              className="w-full pl-8 pr-2 py-1.5 text-xs bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>
          <button
            onClick={() => loadFromUrls([urlInput], true)}
            disabled={!urlInput.trim() || downloadProgress !== null}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded-lg text-white transition"
            title="Descargar estudio y guardarlo para ver sin internet"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Descargar</span>
          </button>
          <button
            onClick={() => setShowBatchModal(true)}
            className="p-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-300"
            title="Pegar múltiples ligas (serie completa)"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {/* Botones de Biblioteca Offline y Archivo Local */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowOfflineModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 rounded-lg transition"
          >
            <FolderDown className="w-3.5 h-3.5" />
            <span>Guardados ({savedStudies.length})</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-200"
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Abrir .dcm</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".dcm,application/dicom"
            className="hidden"
            onChange={(e) => handleLocalFiles(e.target.files)}
          />
        </div>
      </header>

      {/* NOTIFICACIÓN DE PROGRESO O ESTADO */}
      {downloadProgress && (
        <div className="px-4 py-1.5 bg-sky-950 border-b border-sky-800 text-xs text-sky-200 flex items-center justify-between">
          <span>Descargando corte {downloadProgress.current} de {downloadProgress.total} y guardando offline...</span>
          <div className="w-32 h-1.5 bg-sky-900 rounded-full overflow-hidden">
            <div
              className="h-full bg-sky-400 transition-all"
              style={{ width: `${(downloadProgress.current / downloadProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {statusMessage && (
        <div
          className={`px-4 py-1.5 text-xs flex items-center justify-between border-b ${
            statusMessage.type === 'error'
              ? 'bg-rose-950/90 border-rose-800 text-rose-200'
              : 'bg-emerald-950/90 border-emerald-800 text-emerald-200'
          }`}
        >
          <span>{statusMessage.text}</span>
          <button onClick={() => setStatusMessage(null)} className="p-0.5 hover:opacity-75">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* BARRA DE HERRAMIENTAS CLÍNICAS */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-900/80 border-b border-slate-800">
        <div className="flex items-center gap-1">
          {[
            { id: 'wl', icon: Contrast, label: 'Brillo/Contraste' },
            { id: 'pan', icon: Move, label: 'Mover' },
            { id: 'zoom', icon: ZoomIn, label: 'Zoom' },
            { id: 'measure', icon: Ruler, label: 'Medir mm' },
          ].map((tool) => {
            const Icon = tool.icon;
            const active = activeTool === tool.id;
            return (
              <button
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                  active
                    ? 'bg-sky-600 text-white shadow-sm'
                    : 'bg-slate-800/70 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden md:inline">{tool.label}</span>
              </button>
            );
          })}

          <div className="h-5 w-px bg-slate-800 mx-1" />

          <button
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="p-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 text-slate-300"
            title="Rotar 90°"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setFlipH((f) => !f)}
            className="p-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 text-slate-300"
            title="Voltear horizontal"
          >
            <FlipHorizontal className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setInvertColors((i) => !i)}
            className="p-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 text-slate-300"
            title="Invertir escala de grises"
          >
            <Sun className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              if (currentSlice) {
                setWindowCenter(currentSlice.defaultWindowCenter);
                setWindowWidth(currentSlice.defaultWindowWidth);
              }
              setZoom(1);
              setPan({ x: 0, y: 0 });
              setRotation(0);
              setFlipH(false);
              setMeasurements([]);
            }}
            className="p-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 text-slate-300"
            title="Restablecer vista"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Presets de ventana clínica */}
        <div className="flex items-center gap-1 overflow-x-auto">
          <Sliders className="w-3.5 h-3.5 text-slate-400 mr-1 hidden sm:inline" />
          {WINDOW_PRESETS.map((preset) => (
            <button
              key={preset.name}
              onClick={() => {
                if (preset.wc === null && currentSlice) {
                  setWindowCenter(currentSlice.defaultWindowCenter);
                  setWindowWidth(currentSlice.defaultWindowWidth);
                } else {
                  setWindowCenter(preset.wc);
                  setWindowWidth(preset.ww);
                }
              }}
              className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700/70 whitespace-nowrap"
            >
              {preset.name}
            </button>
          ))}
        </div>

        {/* Acciones de guardado manual y compartir */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleSaveCurrentStudyOffline}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 rounded-lg"
            title="Guardar estudio actual en la tablet"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Guardar Offline</span>
          </button>
          <button
            onClick={() => {
              generateShareableLink();
              setShowShareModal(true);
            }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 rounded-lg"
          >
            <Share2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Compartir Liga</span>
          </button>
        </div>
      </div>

      {/* ÁREA PRINCIPAL DEL VISOR CANVAS */}
      <main className="relative flex-1 bg-slate-950 overflow-hidden touch-none">
        <canvas
          ref={canvasRef}
          onMouseDown={(e) => handlePointerDown(e.clientX, e.clientY)}
          onMouseMove={(e) => handlePointerMove(e.clientX, e.clientY)}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onWheel={handleWheel}
          className="w-full h-full block cursor-crosshair"
        />

        {/* OVERLAY METADATOS CLÍNICOS (SUPERIOR IZQUIERDA) */}
        {currentSlice && (
          <div className="pointer-events-none absolute top-3 left-3 text-[11px] leading-relaxed text-sky-300/90 font-mono drop-shadow">
            <div className="font-bold text-white text-xs">{currentSlice.metadata.patientName}</div>
            <div>ID: {currentSlice.metadata.patientId} | Mod: {currentSlice.metadata.modality}</div>
            <div>Fecha: {currentSlice.metadata.studyDate}</div>
            <div className="text-slate-400">{currentSlice.metadata.studyDescription}</div>
          </div>
        )}

        {/* OVERLAY PARÁMETROS DE IMAGEN (INFERIOR IZQUIERDA) */}
        {currentSlice && (
          <div className="pointer-events-none absolute bottom-14 left-3 text-[11px] leading-relaxed text-slate-300 font-mono drop-shadow">
            <div>Corte: {currentSliceIdx + 1} / {slices.length}</div>
            <div>WL: {windowCenter} | WW: {windowWidth}</div>
            <div>Zoom: {(zoom * 100).toFixed(0)}% | Matriz: {currentSlice.cols}x{currentSlice.rows}</div>
          </div>
        )}

        {/* CONTROLES DE NAVEGACIÓN DE CORTES (BARRA INFERIOR) */}
        {slices.length > 1 && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-slate-900/90 border border-slate-700/80 rounded-full backdrop-blur-sm shadow-lg w-[92%] max-w-md">
            <button
              onClick={() => setIsPlaying((p) => !p)}
              className="p-1 text-sky-400 hover:text-sky-300"
              title="Reproducir serie"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setCurrentSliceIdx((i) => Math.max(0, i - 1))}
              className="p-1 text-slate-300 hover:text-white"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="range"
              min={0}
              max={slices.length - 1}
              value={currentSliceIdx}
              onChange={(e) => setCurrentSliceIdx(Number(e.target.value))}
              className="flex-1 accent-sky-500 h-1.5 bg-slate-700 rounded-lg cursor-pointer"
            />
            <button
              onClick={() => setCurrentSliceIdx((i) => Math.min(slices.length - 1, i + 1))}
              className="p-1 text-slate-300 hover:text-white"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-[11px] font-mono text-slate-300 min-w-[42px] text-right">
              {currentSliceIdx + 1}/{slices.length}
            </span>
          </div>
        )}
      </main>

      {/* MODAL: BIBLIOTECA OFFLINE (ESTUDIOS GUARDADOS EN LA TABLET) */}
      {showOfflineModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <FolderDown className="w-5 h-5 text-emerald-400" />
                <h2 className="text-base font-bold text-white">Estudios Guardados Sin Internet</h2>
              </div>
              <button onClick={() => setShowOfflineModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-4 max-h-80 overflow-y-auto space-y-2">
              {savedStudies.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">
                  Aún no tienes estudios guardados en tu dispositivo.<br />
                  Pega una liga DICOM arriba y toca <b>Descargar</b> para guardarlo aquí.
                </div>
              ) : (
                savedStudies.map((study) => (
                  <div
                    key={study.id}
                    className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-xl hover:border-slate-700"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="text-sm font-semibold text-white truncate">{study.patientName}</div>
                      <div className="text-xs text-slate-400 truncate">{study.studyDescription}</div>
                      <div className="text-[11px] text-emerald-400 mt-0.5">
                        {study.modality} • {study.sliceCount} corte(s) • {study.sizeMB} MB • {study.studyDate}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => handleOpenSavedStudy(study)}
                        className="px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-lg"
                      >
                        Abrir
                      </button>
                      <button
                        onClick={() => handleDeleteSavedStudy(study.id)}
                        className="p-1.5 text-rose-400 hover:bg-rose-950 rounded-lg"
                        title="Eliminar de la memoria"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: MÚLTIPLES LIGAS (SERIE COMPLETA) */}
      {showBatchModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-sky-400" />
                <h2 className="text-base font-bold text-white">Descargar Serie por Lote de Ligas</h2>
              </div>
              <button onClick={() => setShowBatchModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-3">
              Pega una liga por línea (ej. todos los cortes `.dcm` de una tomografía o resonancia). Se descargarán y guardarán juntos para consulta sin Internet.
            </p>
            <textarea
              rows={6}
              value={batchUrlsText}
              onChange={(e) => setBatchUrlsText(e.target.value)}
              placeholder={"https://servidor.com/estudio/corte01.dcm\nhttps://servidor.com/estudio/corte02.dcm"}
              className="w-full mt-3 p-2.5 text-xs font-mono bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-sky-500"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowBatchModal(false)}
                className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  const list = batchUrlsText.split('\n');
                  setShowBatchModal(false);
                  loadFromUrls(list, true);
                }}
                className="px-4 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 rounded-lg text-white"
              >
                Descargar y Guardar Todo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: COMPARTIR LIGA CON TOKEN */}
      {showShareModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-sky-400" />
                <h2 className="text-base font-bold text-white">Generar Liga Compartible</h2>
              </div>
              <button onClick={() => setShowShareModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">PIN de acceso opcional (4 dígitos):</label>
                <input
                  type="text"
                  maxLength={6}
                  value={sharePin}
                  onChange={(e) => {
                    setSharePin(e.target.value);
                  }}
                  placeholder="Ej. 1985"
                  className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-slate-700 rounded-lg text-white"
                />
              </div>
              <button
                onClick={generateShareableLink}
                className="w-full py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sky-300"
              >
                Actualizar Enlace
              </button>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Liga lista para enviar:</label>
                <input
                  type="text"
                  readOnly
                  value={generatedLink}
                  onClick={(e) => e.target.select()}
                  className="w-full px-3 py-2 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded-lg text-emerald-300"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}