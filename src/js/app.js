const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const dashboard = document.getElementById('dashboard');
const loadingMsg = document.getElementById('loadingMsg');
const errorMsg = document.getElementById('errorMsg');
const btnExample1 = document.getElementById('btnExample1');
const btnExample2 = document.getElementById('btnExample2');

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
btnExample1.addEventListener('click', () => loadExampleFile('assets/example1.fit'));
btnExample2.addEventListener('click', () => loadExampleFile('assets/example2.csv'));

function handleDrop(e) { handleFiles(e.dataTransfer.files); }

async function loadExampleFile(url) {
    const ext = url.split('.').pop().toLowerCase();

    hideError();
    loadingMsg.classList.remove('hidden');
    dashboard.classList.add('hidden');

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Le fichier d'exemple n'a pas pu être chargé: ${response.statusText}`);
        }

        if (ext === 'fit') {
            const buffer = await response.arrayBuffer();
            parseFitFile(buffer);
        } else if (ext === 'csv') {
            const text = await response.text();
            parseCSVFile(text);
        }
    } catch (error) {
        showError(error.message);
        loadingMsg.classList.add('hidden');
    }
}

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
function parseFitFile(buffer, callback) {
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
            if (callback) callback(lastAnalysisData);
        });
    } catch (err) {
        console.error("Erreur détaillée du parser FIT:", err);
        showError("Erreur lors du chargement de la bibliothèque Garmin.");
    }
}

// --- PARSER SHEARWATER (.CSV) ---
function parseCSVFile(text, callback) {
    // Shearwater CSV a un en-tête de métadonnées de 2 lignes, puis la ligne d'en-tête de données.
    const lines = text.split('\n');
    const headerRowIndex = lines.findIndex(line => line.startsWith('Time (sec)'));

    if (headerRowIndex === -1) {
        showError("En-tête de données CSV ('Time (sec)') introuvable. Est-ce un export Shearwater valide ?");
        return;
    }

    // Reformer le texte CSV pour PapaParse, en commençant par la ligne d'en-tête.
    const csvContent = lines.slice(headerRowIndex).join('\n');

    window.Papa.parse(csvContent, {
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
                    // Le temps est en secondes, nous le convertissons en minutes pour le graphique.
                    let t = parseFloat(String(tRaw).replace(',', '.')) / 60;
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
            if (callback) callback(lastAnalysisData);
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

    // Détection des Phases et Exercices (premier passage)
    let ascents = [];
    let currentAscent = null;
    let timeAtSafetyStop = 0;

    for (let i = 0; i < diveProfile.length; i++) {
        let p = diveProfile[i];
        let prevP = i > 0 ? diveProfile[i - 1] : p;

        if (p.speed > 3) p.phase = 'descent';

        if (p.y >= 2 && p.y <= 6 && Math.abs(p.speed) < 2) {
            p.phase = 'stop';
            timeAtSafetyStop += (p.x - prevP.x);
        }

        if (p.speed <= -2.0) {
            if (!currentAscent) {
                currentAscent = { points: [], speeds: [] };
            }
            currentAscent.points.push(p);
            currentAscent.speeds.push(Math.abs(p.speed));
            currentAscent.pauseTimer = 0;
        } else if (currentAscent) {
            let dt = p.x - prevP.x;
            currentAscent.pauseTimer += dt;
            if (currentAscent.pauseTimer > 0.5) {
                ascents.push(currentAscent);
                currentAscent = null;
            } else {
                currentAscent.points.push(p);
                currentAscent.speeds.push(Math.abs(p.speed));
            }
        }
    }

    if (currentAscent) {
        ascents.push(currentAscent);
    }

    // --- AFFINAGE DES REMONTÉES DÉTECTÉES ---
    diveProfile.forEach(p => { if (p.phase === 'ascent') p.phase = 'bottom'; });

    const finalAscents = ascents.map(asc => {
        if (asc.points.length < 2) return null;

        // 1. Find the absolute max depth in this potential ascent segment.
        let maxDepthInSegment = -1;
        asc.points.forEach(p => {
            if (p.y > maxDepthInSegment) {
                maxDepthInSegment = p.y;
            }
        });

        // 2. Find the LAST point in the segment that is at this max depth.
        // This marks the true beginning of the ascent, after any bottom time.
        let lastMaxDepthIndex = -1;
        for (let i = asc.points.length - 1; i >= 0; i--) {
            // Use a small tolerance to account for minor depth fluctuations at the bottom.
            if (Math.abs(asc.points[i].y - maxDepthInSegment) < 0.5) {
                lastMaxDepthIndex = i;
                break;
            }
        }

        if (lastMaxDepthIndex === -1) {
            lastMaxDepthIndex = 0; // Fallback, should not happen often.
        }

        // 3. Find the highest point (minimum depth) AFTER the ascent has started.
        let minDepth = maxDepthInSegment;
        let minDepthIndex = lastMaxDepthIndex;
        for (let i = lastMaxDepthIndex; i < asc.points.length; i++) {
            if (asc.points[i].y <= minDepth) {
                minDepth = asc.points[i].y;
                minDepthIndex = i;
            }
        }

        const trimmedPoints = asc.points.slice(lastMaxDepthIndex, minDepthIndex + 1);
        if (trimmedPoints.length < 2) return null;

        const startPoint = trimmedPoints[0];
        const endPoint = trimmedPoints[trimmedPoints.length - 1];
        if (startPoint.y - endPoint.y < 8) return null;

        trimmedPoints.forEach(p => p.phase = 'ascent');

        return {
            points: trimmedPoints,
            speeds: asc.speeds.slice(lastMaxDepthIndex, minDepthIndex + 1),
            startPoint,
            endPoint
        };
    }).filter(Boolean);

    // --- NOTATION FFESSM & MISE À JOUR UI ---
    finalAscents.forEach(asc => {
        let amplitude = asc.startPoint.y - asc.endPoint.y;
        let duration = asc.endPoint.x - asc.startPoint.x;
        asc.avgSpeed = duration > 0 ? amplitude / duration : 0;
        asc.maxSpeed = Math.max(...asc.speeds);

        let mean = asc.avgSpeed;
        let variance = asc.speeds.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / asc.speeds.length;
        asc.stdDev = Math.sqrt(variance);

        asc.dropsDetected = 0;
        asc.stopsDuration = 0;
        for (let k = 1; k < asc.points.length; k++) {
            if (asc.points[k].y - asc.points[k - 1].y > 0.3) asc.dropsDetected++;
            if (Math.abs(asc.points[k].speed) < 1.5) asc.stopsDuration += (asc.points[k].x - asc.points[k - 1].x);
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

    document.getElementById('statMaxDepth').innerHTML = `${maxDepth.toFixed(1)} <span class="text-lg text-slate-500 font-medium">m</span>`;
    document.getElementById('statDuration').innerHTML = `${Math.floor(durationMin)} <span class="text-lg text-slate-500 font-medium">min</span>`;
    document.getElementById('statAscentCount').textContent = finalAscents.length;

    let safetyText = timeAtSafetyStop > 2 ? "Validé" : (timeAtSafetyStop > 0.5 ? "Tronqué" : "Absent");
    document.getElementById('statSafety').textContent = safetyText;
    document.getElementById('statSafety').className = `text-2xl font-black mt-1 ${safetyText === "Validé" ? "text-neongreen" : safetyText === "Tronqué" ? "text-orange-400" : "text-slate-500"}`;

    loadingMsg.classList.add('hidden');
    renderAscentCards(finalAscents);
    drawChart(diveProfile);

    lastAnalysisData = {
        maxDepth: maxDepth.toFixed(1),
        durationMin: Math.floor(durationMin),
        safetyStatus: safetyText,
        ascents: finalAscents.map((a, i) => ({
            id: i + 1,
            startDepth: a.startPoint.y.toFixed(1),
            endDepth: a.endPoint.y.toFixed(1),
            avgSpeed: a.avgSpeed.toFixed(1),
            maxSpeed: a.maxSpeed.toFixed(1),
            score: a.score,
            remarks: a.remarks
        }))
    };

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
window.getAIAnalysis = async function () {
    const apiKey = "AIzaSyA3OoHCyHbY9SIIAf8ywRXfMLyeMIy1soE";

    if (!lastAnalysisData) {
        alert("Veuillez d'abord analyser un fichier de plongée avant de demander l'avis de l'expert.");
        return;
    }

    const btn = document.getElementById('btnGetAIAnalysis');
    const placeholder = document.getElementById('aiPlaceholder');
    const loading = document.getElementById('aiLoading');
    const resultDiv = document.getElementById('aiResult');

    placeholder.classList.add('hidden');
    loading.classList.remove('hidden');
    resultDiv.classList.add('hidden');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');

    const prompt = `
        Tu es un instructeur GSP (Guide de Palanquée) anonyme. Ton ton est direct, un peu bourru mais drôle, et tu utilises beaucoup d'émoticônes. Sois bref et va droit au but.

        Voici les données de la plongée :
        - Profondeur max : ${lastAnalysisData.maxDepth} m
        - Durée : ${lastAnalysisData.durationMin} min
        - Palier de sécu : ${lastAnalysisData.safetyStatus}

        Exercices de Remontée Assistée (RA) :
        ${lastAnalysisData.ascents.length > 0 ?
            lastAnalysisData.ascents.map(a => `
            - RA n°${a.id} (${a.startDepth}m -> ${a.endDepth}m) : Vitesse moy: ${a.avgSpeed} m/min, Pic max: ${a.maxSpeed} m/min. Note: ${a.score}/10. Remarques: ${a.remarks.join(', ')}
            `).join('\\n') : "Aucun exercice de RA significatif. On a bullé ? 🤔"
        }

        Ta mission, si tu l'acceptes 📜 :
        1. Analyse globale : Un commentaire rapide sur le profil de la plongée.
        2. Évaluation des RA : Pour chaque RA, UN conseil technique CLÉ pour s'améliorer. Sois direct !
        3. Le conseil ULTIME : Une phrase choc pour la préparation N4.
        Rédige en Markdown. Utilise des émojis pour rendre ça plus fun ! 😉
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
        .replace(/^#### (.*$)/gim, '<h4 class="text-lg font-semibold text-white mt-4 mb-2 flex items-center gap-2"><span class="text-accent">💡</span>$1</h4>')
        .replace(/^### (.*$)/gim, '<h3 class="text-xl font-bold text-neonblue mt-6 mb-3 flex items-center gap-3"><span class="text-2xl">👉</span>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2 class="text-2xl font-bold text-accent mt-8 mb-4 border-b-2 border-accent/30 pb-2 flex items-center gap-3"><span class="text-3xl">🎯</span>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1 class="text-3xl font-black text-white mt-10 mb-6 border-b-4 border-neonblue/50 pb-3 flex items-center gap-4"><span class="text-4xl">🌊</span>$1</h1>')

        // Bold and Italics
        .replace(/\*\*\*(.*?)\*\*\*/gim, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.*?)\*\*/gim, '<strong class="text-white font-semibold">$1</strong>')
        .replace(/\*(.*?)\*/gim, '<em>$1</em>')

        // Lists
        .replace(/^\s*\n\*/gim, '<ul>\n*')
        .replace(/^ {2,}\* (.*$)/gim, (match, p1) => `<ul class="ml-4 mt-2"><li>${p1.trim()}</li></ul>`) // Nested lists
        .replace(/^\* (.*$)/gim, (match, content) => {
            const lowerContent = content.toLowerCase();
            let icon = '➡️';
            if (lowerContent.includes('danger') || lowerContent.includes('inadmissible') || lowerContent.includes('inacceptable') || lowerContent.includes('trop lent') || lowerContent.includes('catastrophe')) {
                icon = '🚨';
            } else if (lowerContent.includes('excellent') || lowerContent.includes('parfait') || lowerContent.includes('bien') || lowerContent.includes('validé') || lowerContent.includes('maîtrise')) {
                icon = '✅';
            } else if (lowerContent.includes('conseil') || lowerContent.includes('astuce')) {
                icon = '💡';
            }
            return `<li class="flex items-start gap-3 my-2"><span class="text-xl">${icon}</span><span>${content.trim()}</span></li>`;
        })

        // Horizontal Rule
        .replace(/---/gim, '<hr class="my-6 border-slate-700/50">')

        // Paragraphs and line breaks
        .replace(/\n\n/gim, '</p><p class="my-4">')
        .replace(/\n/gim, '<br>')

        // Cleanup of stray tags to avoid creating new paragraphs after list rendering
        .replace(/<\/ul><br>/gim, '</ul>')
        .replace(/<\/li><br>/gim, '</li>')
        // Wrap the whole thing in a starting and ending p tag to ensure proper formatting
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
}
