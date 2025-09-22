const recordButton = document.getElementById("recordButton");
const statusBadge = document.getElementById("status");
const waveCanvas = document.getElementById("waveCanvas");
const transcriptView = document.getElementById("transcriptView");
const liveTranscriptText = document.getElementById("liveTranscriptText");
const copyTopRight = document.getElementById("copyTopRight");
const audioPlayer = document.getElementById("player");

// Menu / settings
const menuButton = document.getElementById("menuButton");
const menuPanel = document.getElementById("menuPanel");
const closeMenu = document.getElementById("closeMenu");
const languageSelect = document.getElementById("languageSelect");
const micSelect = document.getElementById("micSelect");
const darkModeToggle = document.getElementById("darkModeToggle");
const refreshMicsBtn = document.getElementById("refreshMics");
const clearAllButton = document.getElementById("clearAll");
const historyList = document.getElementById("historyList");
const historyItemTemplate = document.getElementById("historyItemTemplate");

const STORAGE_KEY = "rec_ia_transcricoes";
const PREF_KEY = "rec_ia_prefs";

const state = {
    transcripts: [],
    mediaRecorder: null,
    mediaStream: null,
    recordedChunks: [],
    isRecording: false,
    audioContext: null,
    modelPromise: null,
    asr: null,
    statusTimer: null,
	analyser: null,
	waveAnimation: null,
	language: "auto",
	dark: false,
	lastRecordedBlob: null,
	deviceId: null,
};

function setStatus(message, variant = "idle", options = {}) {
    const variants = ["idle", "loading", "recording"];
    statusBadge.textContent = message;
    variants.forEach((item) => statusBadge.classList.remove(item));
    statusBadge.classList.add(variant);

    if (state.statusTimer) {
        clearTimeout(state.statusTimer);
        state.statusTimer = null;
    }

    if (options.temporary) {
        state.statusTimer = setTimeout(() => {
            statusBadge.textContent = "Pronto";
            variants.forEach((item) => statusBadge.classList.remove(item));
            statusBadge.classList.add("idle");
            state.statusTimer = null;
        }, options.duration ?? 2000);
    }
}

function isSecureContextOk() {
    return window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

function loadTranscripts() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) {
            return [];
        }
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
            return parsed;
        }
    } catch (_error) {
        console.warn("Nao foi possivel ler as transcricoes salvas.");
    }
    return [];
}

function saveTranscripts() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.transcripts));
}

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREF_KEY);
        if (!raw) return;
        const prefs = JSON.parse(raw);
        if (prefs && typeof prefs === "object") {
            if (prefs.language) state.language = prefs.language;
            if (prefs.dark === true || prefs.dark === false) state.dark = prefs.dark;
        }
        if (prefs.deviceId) state.deviceId = prefs.deviceId;
    } catch (_e) {}
}

function savePrefs() {
    localStorage.setItem(PREF_KEY, JSON.stringify({ language: state.language, dark: state.dark, deviceId: state.deviceId }));
}

function formatTimestamp(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString();
}

function renderHistoryList() {
    historyList.innerHTML = "";
    if (state.transcripts.length === 0) {
        const li = document.createElement("li");
        li.className = "hint";
        li.textContent = "Sem transcrições ainda.";
        historyList.appendChild(li);
        return;
    }

    state.transcripts.forEach((item) => {
        const clone = historyItemTemplate.content.cloneNode(true);
        const btn = clone.querySelector(".history-open");
        const title = clone.querySelector(".history-title");
        const meta = clone.querySelector(".history-meta");
        title.textContent = formatTimestamp(item.createdAt);
        meta.textContent = formatDuration(item.durationSec);
        btn.addEventListener("click", () => openTranscript(item.id));
        historyList.appendChild(clone);
    });
}

function persistAndRender() {
    saveTranscripts();
    renderHistoryList();
}

function ensureAudioContext() {
    if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return state.audioContext;
}

function ensureAnalyser(streamSource) {
    const audioCtx = ensureAudioContext();
    if (!state.analyser) {
        state.analyser = audioCtx.createAnalyser();
        state.analyser.fftSize = 2048;
        state.analyser.smoothingTimeConstant = 0.85;
    }
    streamSource.connect(state.analyser);
    return state.analyser;
}

async function prepareModel() {
    if (state.asr) {
        return state.asr;
    }

    if (!window.transformers || typeof window.transformers.pipeline !== "function") {
        throw new Error("Biblioteca de IA nao carregada.");
    }

    if (!state.modelPromise) {
        setStatus("Carregando modelo...", "loading");
        state.modelPromise = window.transformers.pipeline(
            "automatic-speech-recognition",
            "Xenova/whisper-tiny",
            { quantized: true }
        );
    }

    try {
        state.asr = await state.modelPromise;
        if (!state.isRecording) {
            setStatus("Pronto", "idle");
        }
        return state.asr;
    } catch (error) {
        state.modelPromise = null;
        throw error;
    }
}

function resetRecorderState() {
    if (state.mediaRecorder) {
        state.mediaRecorder.ondataavailable = null;
        state.mediaRecorder.onstop = null;
    }
    state.mediaRecorder = null;
    state.recordedChunks = [];
    state.isRecording = false;
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach((track) => track.stop());
    }
    state.mediaStream = null;
    recordButton.textContent = "Iniciar gravacao";
    recordButton.disabled = false;
}

async function startRecording() {
    try {
        await prepareModel();
    } catch (error) {
        console.error(error);
        setStatus("Falha ao carregar o modelo", "loading", { temporary: true, duration: 3000 });
        recordButton.disabled = true;
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("Microfone nao suportado neste navegador", "loading", { temporary: true });
        return;
    }

    if (!isSecureContextOk()) {
        setStatus("Necessita HTTPS para acessar o microfone", "loading", { temporary: true, duration: 4000 });
        return;
    }

    try {
        // Ensure AudioContext is running (iOS requires resume after user gesture)
        const ctx = ensureAudioContext();
        if (ctx.state === "suspended") {
            try { await ctx.resume(); } catch (_e) {}
        }

        // Prefer selected device; otherwise default system. Add common processing flags.
        // If user chose 'default', don't pass deviceId; let OS pick the system default (Windows/macOS)
        const useDeviceId = state.deviceId && state.deviceId !== "default";
        let constraints = useDeviceId
            ? { audio: { deviceId: { exact: state.deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
            : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (_firstErr) {
            // Fallback to any available input
            constraints = { audio: true };
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        }

        // Update device list selection to reflect used device
        try { await populateMics(); } catch (_e) {}

        // Choose supported mime type
        const candidates = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/ogg;codecs=opus",
            "audio/mp4"
        ];
        let chosenType = "";
        if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === "function") {
            for (const t of candidates) {
                if (MediaRecorder.isTypeSupported(t)) { chosenType = t; break; }
            }
        }
        const mediaRecorder = chosenType ? new MediaRecorder(stream, { mimeType: chosenType }) : new MediaRecorder(stream);

        state.mediaStream = stream;
        state.mediaRecorder = mediaRecorder;
        state.recordedChunks = [];
        state.isRecording = true;

        // Waveform visualization
        startWaveform(stream);

        mediaRecorder.addEventListener("dataavailable", (event) => {
            if (event.data && event.data.size > 0) {
                state.recordedChunks.push(event.data);
            }
        });

        mediaRecorder.addEventListener("stop", async () => {
            const blobType = chosenType || "audio/webm";
            const blob = new Blob(state.recordedChunks, { type: blobType });
            state.recordedChunks = [];
            state.lastRecordedBlob = blob;
            stopWaveform();
            await transcribeBlob(blob);
            resetRecorderState();
        });

        mediaRecorder.start();
        recordButton.textContent = "Parar gravacao";
        setStatus("Gravando...", "recording");
        showCanvas();
    } catch (error) {
        console.error(error);
        const msg = (error && error.name) ? `${error.name}: ${error.message || "Erro no microfone"}` : "Erro no microfone";
        setStatus(msg, "loading", { temporary: true, duration: 4000 });
        resetRecorderState();
    }
}

async function stopRecording() {
    if (state.mediaRecorder && state.isRecording) {
        try {
            state.mediaRecorder.stop();
        } catch (error) {
            console.error(error);
            resetRecorderState();
        }
    }
}

async function transcribeBlob(blob) {
    if (!blob || blob.size === 0) {
        setStatus("Nenhum audio capturado", "idle", { temporary: true });
        return;
    }

    setStatus("Transcrevendo...", "loading");

    try {
        const audioData = await decodeAudioBlob(blob);
        const asr = await prepareModel();
        const opts = {};
        if (state.language && state.language !== "auto") {
            opts.language = state.language;
        }
        const result = await asr({ array: audioData.array, sampling_rate: audioData.samplingRate }, opts);
        const text = (result && result.text ? result.text : "").trim();

        if (!text) {
            setStatus("Nada reconhecido", "idle", { temporary: true });
            return;
        }

        await addTranscript(text, blob, audioData.durationSec);
        showTranscript(text, blob);
        setStatus("Pronto", "idle");
    } catch (error) {
        console.error(error);
        setStatus("Erro na transcricao", "loading", { temporary: true, duration: 4000 });
    }
}

async function decodeAudioBlob(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = ensureAudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const channelData = audioBuffer.getChannelData(0);
    const floatArray = new Float32Array(channelData.length);
    floatArray.set(channelData);

    return {
        array: floatArray,
        samplingRate: audioBuffer.sampleRate,
        durationSec: audioBuffer.duration,
    };
}

async function addTranscript(text, blob, durationSec) {
    const id = (window.crypto && typeof window.crypto.randomUUID === "function")
        ? window.crypto.randomUUID()
        : `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
        id,
        text,
        createdAt: new Date().toISOString(),
        durationSec: typeof durationSec === "number" ? durationSec : undefined,
        language: state.language,
    };
    state.transcripts.unshift(entry);
    await saveAudioBlob(id, blob);
    persistAndRender();
}

async function handleCopy(id) {
    const item = state.transcripts.find((entry) => entry.id === id);
    if (!item) {
        return;
    }

    try {
        await navigator.clipboard.writeText(item.text);
        setStatus("Texto copiado", "idle", { temporary: true });
    } catch (error) {
        console.error(error);
        setStatus("Nao foi possivel copiar", "loading", { temporary: true });
    }
}

async function handleCopyTop() {
    const text = (liveTranscriptText.textContent || "").trim();
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        setStatus("Texto copiado", "idle", { temporary: true });
    } catch (_e) {
        setStatus("Nao foi possivel copiar", "loading", { temporary: true });
    }
}

function handleClearAll() {
    state.transcripts = [];
    persistAndRender();
    clearAllAudio().catch(() => {});
    setStatus("Lista limpa", "idle", { temporary: true });
}

recordButton.addEventListener("click", () => {
    if (state.isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
});

clearAllButton.addEventListener("click", handleClearAll);
copyTopRight.addEventListener("click", handleCopyTop);
menuButton.addEventListener("click", () => menuPanel.classList.remove("hidden"));
closeMenu.addEventListener("click", () => menuPanel.classList.add("hidden"));
languageSelect.addEventListener("change", (e) => {
    state.language = e.target.value;
    savePrefs();
});
darkModeToggle.addEventListener("change", (e) => {
    state.dark = !!e.target.checked;
    applyDarkMode();
    savePrefs();
});
micSelect.addEventListener("change", (e) => {
    const value = e.target.value;
    state.deviceId = value || null;
    savePrefs();
});
refreshMicsBtn.addEventListener("click", async () => {
    try {
        // Some browsers require an active permission to reveal labels; try quick prompt
        if (isSecureContextOk()) {
            try {
                const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
                tmp.getTracks().forEach(t => t.stop());
            } catch (_e) {}
        }
        await populateMics();
        setStatus("Lista atualizada", "idle", { temporary: true });
    } catch (_e) {
        setStatus("Falha ao listar microfones", "loading", { temporary: true });
    }
});

state.transcripts = loadTranscripts();
loadPrefs();
applyDarkMode();
initLanguageSelect();
renderHistoryList();
// Request a quick, silent permission to expose device labels for iOS/Safari
(async () => {
    try {
        // Some browsers require a getUserMedia call to reveal device labels
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(t => t.stop());
    } catch (_e) {}
    try { await populateMics(); } catch (_e) {}
})();

// Refresh device list when devices change (e.g., plug lapel mic)
if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", () => {
        populateMics().catch(() => {});
    });
}
prepareModel().catch((error) => {
    console.error(error);
    setStatus("Falha na inicializacao", "loading", { temporary: true, duration: 4000 });
    recordButton.disabled = true;
});

// ---------- UI helpers ----------
function showCanvas() {
    transcriptView.classList.add("hidden");
}

function showTranscript(text, blob) {
    liveTranscriptText.textContent = text;
    transcriptView.classList.remove("hidden");
    if (blob) {
        const url = URL.createObjectURL(blob);
        audioPlayer.src = url;
    }
}

function initLanguageSelect() {
    languageSelect.value = state.language || "auto";
    darkModeToggle.checked = !!state.dark;
}

function applyDarkMode() {
    if (state.dark) {
        document.body.classList.add("dark");
    } else {
        document.body.classList.remove("dark");
    }
}

function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return "";
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60).toString().padStart(2, "0");
    return `${m}m${s}s`;
}

async function populateMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audios = devices.filter((d) => d.kind === "audioinput");
    micSelect.innerHTML = "";
    if (audios.length === 0) {
        const opt = document.createElement("option");
        opt.textContent = "Nenhum microfone";
        micSelect.appendChild(opt);
        return;
    }
    const anyOpt = document.createElement("option");
    anyOpt.value = "default";
    anyOpt.textContent = "Padrão do sistema";
    micSelect.appendChild(anyOpt);
    audios.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microfone ${d.deviceId.slice(-4)}`;
        micSelect.appendChild(opt);
    });
    micSelect.value = state.deviceId || "default";
}
// ---------- Waveform rendering ----------
function startWaveform(stream) {
    try {
        const ctx = ensureAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ensureAnalyser(source);
        const canvas = waveCanvas;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        const c = canvas.getContext("2d");
        c.scale(dpr, dpr);
        const buffer = new Uint8Array(analyser.frequencyBinCount);

        function draw() {
            state.waveAnimation = requestAnimationFrame(draw);
            analyser.getByteTimeDomainData(buffer);
            c.clearRect(0, 0, rect.width, rect.height);
            c.fillStyle = getComputedStyle(document.body).getPropertyValue("--card");
            c.fillRect(0, 0, rect.width, rect.height);
            c.strokeStyle = getComputedStyle(document.body).getPropertyValue("--primary");
            c.lineWidth = 2;
            c.beginPath();
            const slice = rect.width / buffer.length;
            for (let i = 0; i < buffer.length; i++) {
                const v = buffer[i] / 128.0;
                const y = (v * rect.height) / 2;
                const x = i * slice;
                if (i === 0) c.moveTo(x, y);
                else c.lineTo(x, y);
            }
            c.stroke();
        }
        draw();
    } catch (_e) {}
}

function stopWaveform() {
    if (state.waveAnimation) {
        cancelAnimationFrame(state.waveAnimation);
        state.waveAnimation = null;
    }
}

// ---------- IndexedDB for audio ----------
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("rec_ia_db", 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("audio")) {
                db.createObjectStore("audio", { keyPath: "id" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveAudioBlob(id, blob) {
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction("audio", "readwrite");
            tx.objectStore("audio").put({ id, blob });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (_e) {}
}

async function getAudioBlob(id) {
    const db = await openDB();
    const result = await new Promise((resolve, reject) => {
        const tx = db.transaction("audio", "readonly");
        const req = tx.objectStore("audio").get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
}

async function clearAllAudio() {
    const db = await openDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction("audio", "readwrite");
        tx.objectStore("audio").clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

async function openTranscript(id) {
    const item = state.transcripts.find((t) => t.id === id);
    if (!item) return;
    const blob = await getAudioBlob(id);
    showTranscript(item.text, blob);
    menuPanel.classList.add("hidden");
}




