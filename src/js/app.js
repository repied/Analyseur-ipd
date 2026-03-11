const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const dashboard = document.getElementById('dashboard');
const loadingMsg = document.getElementById('loadingMsg');
const errorMsg = document.getElementById('errorMsg');
const geminiInput = document.getElementById('geminiKey');

// Persistance de la clé API
geminiInput.value = localStorage.getItem('gemini_api_key') || '';
geminiInput.addEventListener('change', (e) => {
    localStorage.setItem('gemini_api_key', e.target.value);
});

let diveChartInstance = null;
let lastAnalysisData = null; // Stockage global pour l'IA

// Drag and drop events
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, () => dropzone.classList.add('dragover'), false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, () => dropzone.classList.remove('dragover'), false);
});

dropzone.addEventListener('drop', handleDrop, false);
fileInput.addEventListener('change', (e) => handleFiles(e.target.files), false);

function handleDrop(e) { handleFiles(e.dataTransfer.files); }

function handleFiles(files) {
    if (files.length === 0) return;
    const file = files[0];
    const ext = file.name.split('.').pop().toLowerCase();

    // Validation de l'extension directement via JavaScript
    if (ext !== 'fit' && ext !== 'csv') {
        showError("Format non supporté. Veuillez sélectionner un fichier .fit (Garmin) ou .csv (Shearwater)");
        // Reset file input so user can try again
        fileInput.value = '';
        return;
    }

    hideError();
    loadingMsg.classList.remove('hidden');
    dashboard.classList.add('hidden');

    const reader = new FileReader();

    reader.onload = function (e) {
        if (ext === 'fit') {
            parseFitFile(e.target.result);
        } else if (ext === 'csv') {
            parseCSVFile(e.target.result);
        }
    };

    reader.onerror = function () {
        showError("Erreur de lecture du fichier.");
        loadingMsg.classList.add('hidden');
    };

    if (ext === 'fit') {
        reader.readAsArrayBuffer(file);
    } else {
        reader.readAsText(file);
    }
}

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
    loadingMsg.classList.add('hidden');
}
function hideError() { errorMsg.classList.add('hidden'); }

// --- PARSER GARMIN (.FIT) ---
function parseFitFile(buffer) {
    try {
        const fitParser = new window.FitParser({ force: true, lengthUnit: 'm', elapsedRecordField: true });
        const u8 = new Uint8Array(buffer);
        fitParser.parse(u8, function (error, data) {
            if (error) { showError("Impossible de décoder ce fichier .fit."); return; }

            if (!data || !data.records || data.records.length === 0) {
                showError("Aucune donnée d'enregistrement trouvée.");
                return;
            }

            let records = data.records;
            let diveProfile = [];
            let maxRaw = 0;

            records.forEach(r => { if (r.depth !== undefined && parseFloat(r.depth) > maxRaw) maxRaw = parseFloat(r.depth); });
            const depthFactor = maxRaw > 500 ? 1000 : 1; // Correction pour les montres en millimètres

            const startTime = records[0].timestamp.getTime();

            records.forEach(record => {
                if (record.depth !== undefined) {
                    diveProfile.push({
                        x: (record.timestamp.getTime() - startTime) / 60000,
                        y: parseFloat(record.depth) / depthFactor,
                        speed: 0,
                        phase: 'bottom'
                    });
                }
            });

            runAnalysis(diveProfile);
        });
    } catch (err) {
        showError("Erreur lors du chargement de la bibliothèque Garmin.");
    }
}

// --- PARSER SHEARWATER (.CSV) ---
function parseCSVFile(text) {
    window.Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        complete: function (results) {
            if (results.errors.length > 0 && results.data.length === 0) {
                showError("Le fichier CSV semble corrompu ou illisible.");
                return;
            }

            let data = results.data;
            let keys = Object.keys(data[0]);

            // Trouver intelligemment les colonnes Temps et Profondeur
            let timeKey = keys.find(k => k.toLowerCase().includes('time') || k.toLowerCase().includes('temps'));
            let depthKey = keys.find(k => k.toLowerCase().includes('depth') || k.toLowerCase().includes('profondeur'));

            if (!timeKey || !depthKey) {
                showError("Colonnes 'Time' ou 'Depth' introuvables dans ce CSV. Est-ce bien un export Shearwater ?");
                return;
            }

            let diveProfile = [];
            data.forEach(row => {
                let tRaw = row[timeKey];
                let dRaw = row[depthKey];

                if (tRaw !== undefined && dRaw !== undefined && tRaw !== '' && dRaw !== '') {
                    let tStr = String(tRaw).trim();
                    let t;

                    // Support du format MM:SS ou Minutes décimales
                    if (tStr.includes(':')) {
                        let parts = tStr.split(':');
                        t = parseInt(parts[0]) + parseFloat(parts[1]) / 60;
                    } else {
                        t = parseFloat(tStr.replace(',', '.'));
                    }

                    let d = parseFloat(String(dRaw).replace(',', '.'));

                    if (!isNaN(t) && !isNaN(d)) {
                        diveProfile.push({ x: t, y: d, speed: 0, phase: 'bottom' });
                    }
                }
            });

            if (diveProfile.length === 0) {
                showError("Aucune donnée numérique valide trouvée dans le CSV.");
                return;
            }

            // S'assurer que les points sont dans l'ordre chronologique
            diveProfile.sort((a, b) => a.x - b.x);

            runAnalysis(diveProfile);
        }
    });
}

// --- MOTEUR D'ANALYSE UNIFIÉ ---
function calculateSpeed(profile, index, windowSize = 5) {
    let startIdx = Math.max(0, index - windowSize);
    let dt = profile[index].x - profile[startIdx].x; // en minutes
    if (dt <= 0) return 0;
    let dd = profile[index].y - profile[startIdx].y; // positif = descente
    return dd / dt; // m/min
}

window.runAnalysis = runAnalysis;
function runAnalysis(diveProfile) {
    if (!diveProfile || diveProfile.length === 0) {
        showError("Profil de plongée vide après décodage.");
        return;
    }

    let maxDepth = Math.max(...diveProfile.map(p => p.y));
    let durationMin = diveProfile[diveProfile.length - 1].x;

    // Calcul des vitesses lissées
    for (let i = 0; i < diveProfile.length; i++) {
        diveProfile[i].speed = calculateSpeed(diveProfile, i, 5);
    }

    // Détection des Phases et Exercices
    let ascents = [];
    let currentAscent = null;
    let timeAtSafetyStop = 0;

    for (let i = 0; i < diveProfile.length; i++) {
        let p = diveProfile[i];
        let prevP = i > 0 ? diveProfile[i - 1] : p;

        // 1. Descentes
        if (p.speed > 3) p.phase = 'descent';

        // 2. Paliers (2m à 6m, vitesse très faible)
        if (p.y >= 2 && p.y <= 6 && Math.abs(p.speed) < 2) {
            p.phase = 'stop';
            timeAtSafetyStop += (p.x - prevP.x);
        }

        // 3. Remontées Assistées - AMÉLIORATION DE LA DÉTECTION
        // Ascent threshold: normally > -2 m/min to start an ascent
        if (p.speed <= -2.0) {
            p.phase = 'ascent';

            if (!currentAscent) {
                currentAscent = { startIndex: i, startPoint: p, points: [], speeds: [], drops: 0, stops: 0, pauseTimer: 0 };
            }
            currentAscent.points.push(p);
            currentAscent.speeds.push(Math.abs(p.speed));
            currentAscent.pauseTimer = 0; // reset pause
        } else if (currentAscent) {
            // It's pausing or dropping
            if (p.speed > -2.0) {
                // Tolerate up to 30 seconds of pause/drop without ending the ascent
                let dt = p.x - prevP.x;
                currentAscent.pauseTimer += dt;

                if (currentAscent.pauseTimer > 0.5) { // more than 30s
                    // END ASCENT
                    currentAscent.endIndex = i;
                    currentAscent.endPoint = p;
                    let amplitude = currentAscent.startPoint.y - currentAscent.endPoint.y;
                    if (amplitude >= 8) {
                        ascents.push(currentAscent);
                        for (let j = currentAscent.startIndex; j <= currentAscent.endIndex; j++) diveProfile[j].phase = 'ascent';
                    } else {
                        // Cancel ascent, revert phase
                        for (let j = currentAscent.startIndex; j <= i; j++) if (diveProfile[j].phase === 'ascent') diveProfile[j].phase = 'bottom';
                    }
                    currentAscent = null;
                } else {
                    // still inside the ascent event
                    currentAscent.points.push(p);
                    currentAscent.speeds.push(Math.abs(p.speed));
                    p.phase = 'ascent';
                }
            }
        }
    }

    if (currentAscent) {
        currentAscent.endPoint = diveProfile[diveProfile.length - 1];
        if (currentAscent.startPoint.y - currentAscent.endPoint.y >= 8) ascents.push(currentAscent);
    }

    // Notation FFESSM
    ascents.forEach(asc => {
        let amplitude = asc.startPoint.y - asc.endPoint.y;
        let duration = asc.endPoint.x - asc.startPoint.x;
        asc.avgSpeed = amplitude / duration;
        asc.maxSpeed = Math.max(...asc.speeds);

        let mean = asc.avgSpeed;
        let variance = asc.speeds.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / asc.speeds.length;
        asc.stdDev = Math.sqrt(variance);

        asc.dropsDetected = 0;
        asc.stopsDuration = 0;

        for (let k = 1; k < asc.points.length; k++) {
            let diffY = asc.points[k].y - asc.points[k - 1].y;
            let diffX = asc.points[k].x - asc.points[k - 1].x;
            if (diffY > 0.3) asc.dropsDetected++;
            if (Math.abs(asc.points[k].speed) < 1.5) asc.stopsDuration += diffX;
        }

        let score = 10;
        let remarks = [];

        if (asc.avgSpeed < 9) { score -= 2; remarks.push("Trop lent (moy < 10m/min)"); }
        else if (asc.avgSpeed > 16) { score -= 3; remarks.push("Trop rapide (moy > 15m/min)"); }
        else { remarks.push("Excellente vitesse moyenne"); }

        if (asc.maxSpeed > 22) { score -= 3; remarks.push("Pic dangereux (> 20m/min)"); }
        else if (asc.maxSpeed > 18) { score -= 1.5; remarks.push("Envolée locale constatée"); }

        if (asc.dropsDetected > 2) { score -= 4; remarks.push("Redescentes/Yoyo pénalisants"); }

        if (asc.stdDev > 4) { score -= 1.5; remarks.push("Vitesse irrégulière (à-coups)"); }
        else if (asc.stdDev <= 2.5 && asc.avgSpeed >= 9 && asc.avgSpeed <= 16) { remarks.push("Vitesse très constante"); }

        if (asc.stopsDuration > 0.2) { score -= 1; remarks.push("Arrêt intempestif marqué"); }

        asc.score = Math.max(0, Math.min(10, score));
        asc.remarks = remarks;
    });

    // Mise à jour de l'UI
    document.getElementById('statMaxDepth').innerHTML = `${maxDepth.toFixed(1)} <span class="text-lg text-slate-500 font-medium">m</span>`;
    document.getElementById('statDuration').innerHTML = `${Math.floor(durationMin)} <span class="text-lg text-slate-500 font-medium">min</span>`;
    document.getElementById('statAscentCount').textContent = ascents.length;

    let safetyText = timeAtSafetyStop > 2 ? "Validé" : (timeAtSafetyStop > 0.5 ? "Tronqué" : "Absent");
    document.getElementById('statSafety').textContent = safetyText;
    if (safetyText === "Validé") document.getElementById('statSafety').className = "text-2xl font-black text-neongreen mt-1";
    else if (safetyText === "Tronqué") document.getElementById('statSafety').className = "text-2xl font-black text-orange-400 mt-1";
    else document.getElementById('statSafety').className = "text-2xl font-black text-slate-500 mt-1";

    loadingMsg.classList.add('hidden');
    renderAscentCards(ascents);
    drawChart(diveProfile);

    // Préparation des données pour l'IA
    lastAnalysisData = {
        maxDepth: maxDepth.toFixed(1),
        durationMin: Math.floor(durationMin),
        safetyStatus: safetyText,
        ascents: ascents.map((a, i) => ({
            id: i + 1,
            startDepth: a.startPoint.y.toFixed(1),
            endDepth: a.endPoint.y.toFixed(1),
            avgSpeed: a.avgSpeed.toFixed(1),
            maxSpeed: a.maxSpeed.toFixed(1),
            score: a.score,
            remarks: a.remarks
        }))
    };

    // Afficher la section IA
    document.getElementById('aiAnalysisSection').classList.remove('hidden');
    document.getElementById('aiPlaceholder').classList.remove('hidden');
    document.getElementById('aiLoading').classList.add('hidden');
    document.getElementById('aiResult').classList.add('hidden');

    dashboard.classList.remove('hidden');
}

function renderAscentCards(ascents) {
    const container = document.getElementById('ascentsContainer');
    container.innerHTML = '';

    if (ascents.length === 0) {
        container.innerHTML = `<div class="col-span-1 md:col-span-2 text-center p-12 glass-panel rounded-3xl border border-slate-700 text-slate-400">Aucune remontée > 8m détectée. L'algorithme n'a pas pu isoler d'exercice spécifique.</div>`;
        return;
    }

    ascents.forEach((asc, idx) => {
        let scoreColor = asc.score >= 8 ? 'text-neongreen drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]' :
            asc.score >= 5 ? 'text-orange-400' : 'text-neonred drop-shadow-[0_0_8px_rgba(244,63,94,0.5)]';
        let borderColor = asc.score >= 8 ? 'border-neongreen/30' :
            asc.score >= 5 ? 'border-orange-400/30' : 'border-neonred/30';
        let bgGlow = asc.score >= 8 ? 'bg-neongreen/10' : asc.score >= 5 ? 'bg-orange-400/10' : 'bg-neonred/10';

        const card = document.createElement('div');
        card.className = `p-6 rounded-3xl border ${borderColor} glass-panel relative overflow-hidden group shadow-lg`;

        let remarksHtml = asc.remarks.map(r => {
            let isGood = r.includes("Excellente") || r.includes("constante");
            let icon = isGood ? '✓' : '⚠️';
            let col = isGood ? 'text-neongreen' : 'text-slate-400';
            return `<li class="${col} flex gap-2 text-sm"><span class="font-bold">${icon}</span> ${r}</li>`;
        }).join('');

        card.innerHTML = `
            <div class="absolute inset-0 ${bgGlow} opacity-30"></div>
            <div class="relative z-10 flex justify-between items-start mb-4">
                <div>
                    <h4 class="font-bold text-white text-xl flex items-center gap-2">
                        <span class="bg-slate-700/80 text-slate-200 w-8 h-8 rounded-full flex items-center justify-center text-sm shadow">${idx + 1}</span>
                        Exercice RA
                    </h4>
                    <span class="text-xs text-slate-400 mt-1 block">Déclenché à ${asc.startPoint.x.toFixed(1)} min</span>
                </div>
                <div class="text-right">
                    <span class="block text-xs uppercase tracking-widest text-slate-500 font-bold mb-1">Note FFESSM</span>
                    <span class="text-4xl font-black ${scoreColor}">${asc.score}<span class="text-xl text-slate-500">/10</span></span>
                </div>
            </div>

            <div class="grid grid-cols-3 gap-3 mb-5 relative z-10">
                <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50 text-center backdrop-blur-sm">
                    <span class="block text-[10px] text-slate-400 uppercase mb-1">Trajet</span>
                    <span class="font-bold text-white">${asc.startPoint.y.toFixed(0)}m &rarr; ${asc.endPoint.y.toFixed(0)}m</span>
                </div>
                <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50 text-center backdrop-blur-sm">
                    <span class="block text-[10px] text-slate-400 uppercase mb-1">Vit. Moyenne</span>
                    <span class="font-bold text-white">${asc.avgSpeed.toFixed(1)} <span class="text-xs text-slate-500">m/m</span></span>
                </div>
                <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50 text-center backdrop-blur-sm">
                    <span class="block text-[10px] text-slate-400 uppercase mb-1">Pic Max</span>
                    <span class="font-bold text-white">${asc.maxSpeed.toFixed(1)} <span class="text-xs text-slate-500">m/m</span></span>
                </div>
            </div>

            <div class="relative z-10 bg-slate-900/40 rounded-xl p-4 border border-slate-700/30">
                <span class="text-xs font-bold text-slate-500 uppercase mb-2 block">Détails de la prestation :</span>
                <ul class="space-y-1.5">${remarksHtml}</ul>
            </div>
        `;
        container.appendChild(card);
    });
}

function drawChart(profileData) {
    const ctx = document.getElementById('diveChart').getContext('2d');
    const chartData = profileData.map(d => ({ x: d.x, y: d.y }));

    if (diveChartInstance) diveChartInstance.destroy();

    diveChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Profondeur',
                data: chartData,
                borderWidth: 3,
                pointRadius: 0,
                pointHoverRadius: 6,
                tension: 0.1,
                fill: true,
                backgroundColor: 'rgba(56, 189, 248, 0.05)',
                segment: {
                    borderColor: ctxSegment => {
                        const p = profileData[ctxSegment.p1DataIndex];
                        if (!p) return '#64748b';
                        switch (p.phase) {
                            case 'ascent': return '#f43f5e';
                            case 'descent': return '#0ea5e9';
                            case 'stop': return '#10b981';
                            default: return '#64748b';
                        }
                    }
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleColor: '#38bdf8',
                    bodyColor: '#f8fafc',
                    borderColor: '#334155',
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function (context) { return 'Profondeur: ' + context.parsed.y.toFixed(1) + ' m'; },
                        title: function (context) { return 'Temps: ' + context[0].parsed.x.toFixed(1) + ' min'; }
                    }
                },
                legend: { display: false }
            },
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Temps (minutes)', color: '#94a3b8' },
                    grid: { color: 'rgba(51, 65, 85, 0.2)' },
                    ticks: { color: '#94a3b8' }
                },
                y: {
                    reverse: true,
                    beginAtZero: true,
                    title: { display: true, text: 'Profondeur (m)', color: '#94a3b8' },
                    grid: { color: 'rgba(51, 65, 85, 0.2)' },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

// --- INTÉGRATION IA GEMINI ---
window.askThibault = async function () {
    const apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey) {
        alert("Veuillez d'abord entrer votre clé API Gemini dans le champ prévu en haut de la page.");
        return;
    }

    if (!lastAnalysisData) {
        alert("Veuillez d'abord analyser un fichier de plongée avant de demander l'avis de l'expert.");
        return;
    }

    const btn = document.getElementById('btnAskThibault');
    const placeholder = document.getElementById('aiPlaceholder');
    const loading = document.getElementById('aiLoading');
    const resultDiv = document.getElementById('aiResult');

    placeholder.classList.add('hidden');
    loading.classList.remove('hidden');
    resultDiv.classList.add('hidden');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');

    const prompt = `
        Tu es Thibault DLLM Willer, un expert légendaire de la plongée sous-marine, instructeur fédéral français (FFESSM) et spécialiste de la préparation au Niveau 4 (GP - Guide de Palanquée).
        Tu possèdes une connaissance encyclopédique de la règlementation FFESSM, du Code du Sport français, et des standards de sécurité.
        Ton ton est celui d'un DP (Directeur de Plongée) expérimenté : professionnel, technique, précis, parfois un peu bourru mais toujours bienveillant et pédagogue.

        Voici les données télémétriques d'une plongée que je viens d'effectuer :
        - Profondeur maximale : ${lastAnalysisData.maxDepth} m
        - Durée totale : ${lastAnalysisData.durationMin} min
        - Statut du palier de sécurité : ${lastAnalysisData.safetyStatus}

        Détails des exercices de Remontée Assistée (RA) détectés :
        ${lastAnalysisData.ascents.length > 0 ?
            lastAnalysisData.ascents.map(a => `
            Exercice RA n°${a.id}:
            - Trajet : de ${a.startDepth}m à ${a.endDepth}m
            - Vitesse moyenne : ${a.avgSpeed} m/min
            - Vitesse max : ${a.maxSpeed} m/min
            - Note automatique : ${a.score}/10
            - Remarques du système : ${a.remarks.join(', ')}
            `).join('\\n') : "Aucun exercice de RA significatif détecté."
        }

        Analyse ces données en tant qu'expert FFESSM.
        1. Commente la structure globale de la plongée (profil, profondeur, gestion du temps).
        2. Évalue chaque exercice de RA en donnant des conseils techniques précis pour améliorer la note.
        3. Conclus par un conseil général pour la préparation du Niveau 4.
        Rédige ta réponse en Markdown.
    `;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }]
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error("Erreur de l'API Gemini:", errorData);
            throw new Error(`Erreur ${response.status}: ${errorData.error ? errorData.error.message : response.statusText}`);
        }

        const data = await response.json();

        if (!data.candidates || !data.candidates[0].content || !data.candidates[0].content.parts[0].text) {
            console.error("Réponse de l'API malformée:", data);
            throw new Error("La réponse de l'API est invalide ou ne contient pas de texte.");
        }

        const resultText = data.candidates[0].content.parts[0].text;
        resultDiv.innerHTML = formatMarkdown(resultText);
        resultDiv.classList.remove('hidden');

    } catch (err) {
        console.error("Erreur askThibault:", err);
        resultDiv.innerHTML = `<div class="text-neonred p-4 border border-neonred/30 rounded-xl bg-red-950/20">
            <p class="font-bold mb-1">Erreur lors de la communication avec Thibault :</p>
            <p class="text-sm opacity-90">${err.message}</p>
            <p class="mt-2 text-xs text-slate-500 italic">Vérifiez votre clé API, votre quota et votre connexion internet.</p>
        </div>`;
        resultDiv.classList.remove('hidden');
    } finally {
        loading.classList.add('hidden');
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
};

function formatMarkdown(text) {
    return text
        // Headings
        .replace(/^#### (.*$)/gim, '<h4 class="text-lg font-semibold text-white mt-4 mb-2">$1</h4>')
        .replace(/^### (.*$)/gim, '<h3 class="text-xl font-bold text-neonblue mt-6 mb-3">$1</h3>')
        .replace(/^## (.*$)/gim, '<h2 class="text-2xl font-bold text-accent mt-8 mb-4 border-b-2 border-accent/30 pb-2">$1</h2>')
        .replace(/^# (.*$)/gim, '<h1 class="text-3xl font-black text-white mt-10 mb-6 border-b-4 border-neonblue/50 pb-3">$1</h1>')

        // Bold and Italics
        .replace(/\*\*\*(.*?)\*\*\*/gim, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.*?)\*\*/gim, '<strong class="text-white font-semibold">$1</strong>')
        .replace(/\*(.*?)\*/gim, '<em>$1</em>')

        // Lists
        .replace(/^\s*\n\*/gim, '<ul>\n*')
        .replace(/^ {2,}\* (.*$)/gim, (match, p1) => `<ul><li>${p1.trim()}</li></ul>`) // Nested lists
        .replace(/^\* (.*$)/gim, (match, p1) => `<li>${p1.trim()}</li>`)

        // Horizontal Rule
        .replace(/---/gim, '<hr class="my-6 border-slate-700/50">')

        // Paragraphs
        .replace(/\n\n/gim, '</p><p class="my-4">')
        .replace(/\n/gim, '<br>')

        // Cleanup of stray tags
        .replace(/<\/ul><br>/gim, '</ul>')
        .replace(/<\/li><br>/gim, '</li>');
}
