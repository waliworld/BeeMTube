'use strict';
/**
 * audio8.js - BeeMTube's app asks the car for sound (iDrive 8 only).
 *
 * Why the app and not the service. On iDrive 7 the service plays through BMW's MediaPlayer instance
 * "OapGenericMedia" and that works. On iDrive 8 that instance is not offered to the service, and the car's
 * dynamic media player refused it the audio focus with BAD_ARGUMENT whatever it was asked with. The service is
 * a root daemon nobody provisioned: it is in no app's SOME/IP policy, the app manager knows nothing of it, and
 * it has no app id to give. This app is the other thing entirely - a registered OAP app with BMW's own SDK, its
 * own uid, its own entry in the car's provisioning, and interface descriptions the app manager wrote for it.
 * So the asking happens here, and the service only keeps the file and the picture.
 *
 * Nothing here may ever take the app down with it, so every call into the SDK goes through one wrapper that
 * catches everything and gives up after a while, and the whole module is loaded (and may fail to load) inside a
 * try/catch of its caller. The worst that a car we have not seen can do to us is a refusal.
 *
 * It speaks the service's control socket:
 *   app -> service   { cmd: 'audio_hello', version, report: [..] }    once, at the start
 *                    { cmd: 'audio_res', req, ok, ... }               the answer to one request
 *                    { cmd: 'audio_ev', kind: 'state'|'time'|'error'|'note', value }
 *   service -> app   { ev: 'audio', req, op: 'plans' }                what can you try?
 *                    { ev: 'audio', req, op: 'play', plan, file, at, info }
 *                    { ev: 'audio', req, op: 'replay'|'button'|'seek'|'release', ... }
 *
 * The plans, in the order the service tries them:
 *   bmw             the car's generic OAP media player, exactly as iDrive 7 plays: the audio manager connects
 *                   our source to the loudspeakers (CommandControl.connect), then MediaPlayer.playFile.
 *   dyn:<instance>  the car's dynamic media player: getAudioFocus for a token (its arguments built from the
 *                   interface's own description, so each is of the type the car declares - not a guess), a
 *                   playlist with our file, then a start.
 *   amconnect       only the audio manager's connection, for the service's own player: with our source
 *                   connected, the router reads the device it belongs to and our samples are heard.
 */
const fs = require('fs');
const path = require('path');

const CC = 'org.genivi.am.commandinterface.CommandControl';
const MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const DYN = 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer';
// iDrive 7's measured route; the app's own description is asked for the names this head unit has
const SOURCE_ID = 1046, SINK_ID = 1024, MEDIA_INSTANCE = 'OapGenericMedia', LANGUAGE_CODE = 7695972;
const DYN_ORDER = [/^DynamicMediaPlayerMedia$/, /^DynamicMediaPlayerTempMedia$/, /^DynamicMediaPlayerTempLumMedia$/];

const errText = (e) => String((e && e.message) || e);
/* Whether a player's state means it is playing. "PLAYER_STATE_STOP" holds the letters of PLAY, so the word that
 * says what it is doing is read first: a state that stops, pauses, idles or errs is not playing. */
function isPlaying(v) {
    const t = String(v === null || v === undefined ? '' : (typeof v === 'object' ? (v.state || v.value || '') : v)).toUpperCase();
    if (!t) return false;
    if (/STOP|PAUS|IDLE|ERROR|UNKNOWN|NONE|BUFFER/.test(t)) return false;
    return /PLAY/.test(t);
}
function show(v, max) {
    let t;
    try { t = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { t = String(v); }
    t = String(t === undefined ? 'undefined' : t).replace(/\s+/g, ' ');
    return t.length > (max || 160) ? t.slice(0, max || 160) + '...' : t;
}

/** A promise that never hangs and never throws: { ok, value } or { ok: false, error }. */
function tryFor(fn, ms, what) {
    return new Promise((resolve) => {
        let done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
        const t = setTimeout(() => end({ ok: false, error: what + ' did not answer in ' + ms + ' ms' }), ms);
        let p;
        try { p = Promise.resolve(fn()); } catch (e) { return end({ ok: false, error: errText(e) }); }
        return p.then((v) => end({ ok: true, value: v }), (e) => end({ ok: false, error: errText(e) }));
    });
}

function CarAudio(opts) {
    this.o = opts || {};
    this.log = this.o.log || { info() {}, warn() {}, error() {} };
    this.send = this.o.send || (() => false);
    this.appId = this.o.appId || 'wali_beemtube8';
    this.title = this.o.title || 'BeeMTube';
    this.px = {};             // iface -> the proxy, once built
    this.cfg = {};            // iface -> its description, as the app manager wrote it for us
    this.how = {};            // iface -> how a method is called on its proxy (learned once)
    this.report = [];
    this.plansMemo = null;
    this.active = null;       // what plays now: { plan, ... }
    this.conn = null;         // the audio manager's connection of our source
    this.token = null;        // the dynamic player's audio focus
    this.beat = null;
    this.subscribed = {};
}
CarAudio.prototype.say = function (t) {
    const line = String(t).slice(0, 300);
    if (this.report.length < 120) this.report.push(line);
    this.log.info('car audio: ' + line);
};
CarAudio.prototype.ev = function (kind, value) { this.send({ cmd: 'audio_ev', kind: kind, value: value }); };

/* ------------------------------------------------------------------ the SDK, carefully */

CarAudio.prototype.builders = function () {
    if (this.b !== undefined) return this.b;
    this.b = null;
    try {
        const sdk = require('./kit/sdk');
        const names = Object.keys(sdk || {}).filter((k) => typeof k === 'string');
        this.say('the SDK gives: ' + (names.join(', ') || 'nothing'));
        const b = sdk && sdk.someipBuilders;
        if (b) {
            const fns = Object.keys(b).filter((k) => typeof b[k] === 'function');
            this.say('someipBuilders: ' + (fns.join(', ') || 'no function of its own'));
            if (typeof b.buildAndInitTypedProxy === 'function' || typeof b.buildProxy === 'function') this.b = b;
            else this.say('someipBuilders has neither buildAndInitTypedProxy nor buildProxy: no proxy can be built');
        } else this.say('this SDK has no someipBuilders: the car\'s audio cannot be asked from the app');
    } catch (e) {
        this.say('the SDK could not be read: ' + errText(e));
    }
    return this.b;
};
/* The description the app manager wrote for us out of our manifest, which says the interface's instances and the
 * type of every argument its methods take. */
CarAudio.prototype.describe = function (iface) {
    if (this.cfg[iface] !== undefined) return this.cfg[iface];
    this.cfg[iface] = null;
    const file = iface.replace(/\./g, '_') + '.json';
    const dirs = [path.resolve(__dirname, '..', '..', 'someipInterfaces'), path.join(__dirname, 'someipdefs'),
        path.resolve(__dirname, '..', 'someipInterfaces')];
    for (const d of dirs) {
        try {
            const cfg = JSON.parse(fs.readFileSync(path.join(d, file), 'utf8'));
            this.cfg[iface] = cfg;
            const insts = instancesOf(cfg);
            this.say(iface.split('.').pop() + ': described in ' + path.join(d, file) + ' | service ' +
                (cfg.serviceId !== undefined ? '0x' + Number(cfg.serviceId).toString(16) : '?') +
                ' | instances ' + (insts.join(', ') || 'none named'));
            return cfg;
        } catch (e) { /* the next place */ }
    }
    this.say(iface.split('.').pop() + ': no description for this app on this head unit (its manifest names it, so the app manager should have written one)');
    return null;
};
/* A proxy of an instance, or null. Built once; a car that does not offer it says so and is not asked again. */
CarAudio.prototype.proxy = async function (iface, instance) {
    const key = iface + '|' + instance;
    if (this.px[key] !== undefined) return this.px[key];
    this.px[key] = null;
    const b = this.builders();
    if (!b) return null;
    const ms = this.o.proxyMs || 8000;
    let r;
    if (typeof b.buildAndInitTypedProxy === 'function') {
        r = await tryFor(() => b.buildAndInitTypedProxy(iface, String(instance), ms), ms + 2000, 'buildAndInitTypedProxy(' + instance + ')');
    } else {
        r = await tryFor(() => Promise.resolve(b.buildProxy(iface, String(instance))).then((p) => (p && p.init ? Promise.resolve(p.init()).then(() => p) : p)),
            ms + 2000, 'buildProxy(' + instance + ')');
    }
    if (!r.ok || !r.value) {
        this.say(iface.split('.').pop() + ' ' + instance + ': no proxy (' + (r.error || 'nothing came back') + ')');
        return null;
    }
    this.px[key] = r.value;
    this.say(iface.split('.').pop() + ' ' + instance + ': proxy built');
    return r.value;
};
/* Whether the car offers this instance to us at all. */
CarAudio.prototype.answers = async function (p) {
    if (!p) return false;
    if (typeof p.isAvailable === 'function') {
        const r = await tryFor(() => p.isAvailable(), 3000, 'isAvailable');
        if (r.ok) return !!r.value;
    }
    return true;   // a proxy with no such question: taken as there, the call itself will say
};
/**
 * One method on a proxy. Which shape a typed proxy takes - p.m(args), p.m.call_(args), p.callMethod(m, args) -
 * is not written down anywhere we can read, so the first one that answers is used and kept for the rest.
 * Returns { ok, value } or { ok: false, error }.
 */
CarAudio.prototype.call = async function (iface, p, m, args, ms) {
    ms = ms || this.o.callMs || 6000;
    const ways = [];
    const member = p ? p[m] : null;
    if (typeof member === 'function') ways.push({ how: 'p.' + m + '(args)', run: () => p[m](args) });
    if (member && typeof member === 'object') {
        ['callMethod', 'invoke', 'execute', 'request', 'send', 'call_'].forEach((n) => {
            if (typeof member[n] === 'function') ways.push({ how: 'p.' + m + '.' + n + '(args)', run: () => member[n](args) });
        });
        if (typeof member.call === 'function' && !Function.prototype.hasOwnProperty.call(member, 'call') && Object.prototype.hasOwnProperty.call(member, 'call')) {
            ways.push({ how: 'p.' + m + '.call(args)', run: () => member.call(args) });
        }
    }
    if (p && typeof p.callMethod === 'function') ways.push({ how: 'p.callMethod(m, args, ms)', run: () => p.callMethod(m, args, ms) });
    if (p && typeof p.call === 'function') ways.push({ how: 'p.call(m, args, ms)', run: () => p.call(m, args, ms) });
    if (!ways.length) return { ok: false, error: 'the proxy offers no way to call ' + m };
    // once the shape that answers for this interface is known, use only it: the method was dispatched, so a
    // failure or a timeout is the car's answer, never a reason to send the same call again under another shape
    const known = this.how[iface];
    const knownWay = known && ways.filter((w) => w.how === known)[0];
    if (knownWay) return tryFor(knownWay.run, ms + 1500, m);
    // the first time: try each shape, but fall through ONLY on a synchronous shape mismatch ("is not a
    // function"). A timeout means the call reached the car, so it is not retried under another shape - that would
    // dispatch a mutating call (getAudioFocus, createPlaylist) twice.
    let last = null;
    for (const w of ways) {
        const r = await tryFor(w.run, ms + 1500, m);
        if (r.ok) {
            this.how[iface] = w.how;
            this.say('methods of ' + iface.split('.').pop() + ' are called as ' + w.how);
            return r;
        }
        last = r.error;
        if (!/is not a function|is not a function\)|undefined is not/i.test(String(last))) return r;
    }
    return { ok: false, error: last || 'no way to call ' + m };
};
/* A field or event of the car's player, as it comes. Every handler is caught: the app must not die of one. */
CarAudio.prototype.listen = function (iface, p, name, fn) {
    const key = iface + '|' + name;
    if (this.subscribed[key] || !p) return;
    const safe = (v) => { try { fn(v); } catch (e) { this.log.warn('car audio: ' + name + ': ' + errText(e)); } };
    const member = p[name];
    try {
        if (member && typeof member.subscribe === 'function') { member.subscribe(safe); this.subscribed[key] = true; return; }
        if (typeof p.subscribe === 'function') { p.subscribe({ name: name, onReceive: safe }); this.subscribed[key] = true; return; }
    } catch (e) { this.say('could not listen to ' + name + ': ' + errText(e)); }
};
CarAudio.prototype.value = async function (iface, p, name) {
    const member = p ? p[name] : null;
    if (member && typeof member.getValue === 'function') { const r = await tryFor(() => member.getValue(), 3000, name); return r.ok ? r.value : undefined; }
    if (p && typeof p.getValue === 'function') { const r = await tryFor(() => p.getValue(name, 3000), 4000, name); return r.ok ? r.value : undefined; }
    return undefined;
};

/* ------------------------------------------------------------------ what this car lets us try */

function instancesOf(cfg) {
    if (!cfg) return [];
    const v = cfg.instances;
    if (Array.isArray(v)) return v.map(String);
    if (v && typeof v === 'object') return Object.keys(v);
    return [];
}
/* The argument list of a method, with each argument's declared type: [{ n, t, e }]. */
function argsOf(cfg, method) {
    const m = cfg && cfg.methods && cfg.methods[method];
    const sch = m && (m.schema || m.in || m.args);
    const e = sch && (sch.e || sch.elements || sch.members);
    if (!Array.isArray(e)) return null;
    return e.map((x) => ({ n: x && (x.n || x.name), t: String((x && (x.t || x.type)) || ''), e: x && (x.e || x.enum) }));
}
const isText = (t) => /utf|string|str/i.test(t);
const isNum = (t) => /int|uint|float|double|num/i.test(t);
const isEnum = (t) => /enum|^e\d/i.test(t);

CarAudio.prototype.plans = async function () {
    // what the car offers can change while the head unit finishes starting, so the answer is kept only a while;
    // a proxy that could not be built then is forgotten, so it is tried again and not written off for the run
    if (this.plansMemo && Date.now() - (this.plansAt || 0) < (this.o.plansKeepMs || 120000)) return this.plansMemo;
    Object.keys(this.px).forEach((k) => { if (!this.px[k]) delete this.px[k]; });
    this.cfg = {};
    const out = [];
    const cc = this.describe(CC) !== null ? await this.proxy(CC, this.ccInstance()) : null;
    const ccOk = cc ? await this.answers(cc) : false;
    this.say('the audio manager (CommandControl) ' + (ccOk ? 'answers this app' : cc ? 'does not answer this app' : 'could not be reached'));
    // the generic OAP media player, as iDrive 7 plays
    if (this.describe(MP)) {
        const inst = this.mpInstance();
        const mp = inst ? await this.proxy(MP, inst) : null;
        const ok = mp ? await this.answers(mp) : false;
        this.say('the media player "' + inst + '" ' + (ok ? 'answers this app' : mp ? 'does not answer this app' : 'could not be reached'));
        if (ok && ccOk) out.push({ key: 'bmw', name: 'the car\'s media player (' + inst + ')', holdsPosition: false, inst: inst });
    }
    // the dynamic media player, one plan an instance the car keeps for the entertainment
    const dcfg = this.describe(DYN);
    if (dcfg) {
        const insts = instancesOf(dcfg);
        const want = DYN_ORDER.map((re) => insts.filter((n) => re.test(n))[0]).filter(Boolean);
        for (const inst of (want.length ? want : insts.slice(0, 3))) {
            const p = await this.proxy(DYN, inst);
            const ok = p ? await this.answers(p) : false;
            this.say('the dynamic media player ' + inst + ' ' + (ok ? 'answers this app' : 'does not answer this app'));
            if (ok) out.push({ key: 'dyn:' + inst, name: 'the car\'s dynamic media player (' + inst.replace(/^DynamicMediaPlayer/, '') + ')', holdsPosition: false, inst: inst });
        }
    }
    // and, for the service's own player, the audio manager's connection alone
    if (ccOk) out.push({ key: 'amconnect', name: 'our source connected by the car\'s audio manager', holdsPosition: true });
    this.plansMemo = out;
    this.plansAt = Date.now();
    return out;
};
CarAudio.prototype.ccInstance = function () {
    const insts = instancesOf(this.cfg[CC]);
    return insts.indexOf('1') >= 0 || !insts.length ? '1' : insts[0];
};
CarAudio.prototype.mpInstance = function () {
    const insts = instancesOf(this.cfg[MP]);
    if (!insts.length || insts.indexOf(MEDIA_INSTANCE) >= 0) return MEDIA_INSTANCE;
    const like = insts.filter((n) => /oap|generic/i.test(n));
    return like.length === 1 ? like[0] : null;
};

/* ------------------------------------------------------------------ playing */

/* The audio manager connects our source to the loudspeakers, as an iDrive 7 play does. */
CarAudio.prototype.amConnect = async function () {
    if (this.conn !== null) return { ok: true };
    const p = await this.proxy(CC, this.ccInstance());
    if (!p) return { ok: false, error: 'the car\'s audio manager could not be reached' };
    const src = this.o.sourceID || SOURCE_ID, sink = this.o.sinkID || SINK_ID;
    const r = await this.call(CC, p, 'connect', { sourceID: src, sinkID: sink });
    this.say('connect ' + src + ' > ' + sink + ' -> ' + (r.ok ? show(r.value) : 'failed: ' + r.error));
    if (!r.ok) return { ok: false, error: 'the audio manager refused to connect our source: ' + r.error };
    const v = r.value || {};
    if (v.amError !== undefined && v.amError !== 'E_OK' && v.amError !== 'E_ALREADY_EXISTS') {
        return { ok: false, error: 'the audio manager answered ' + v.amError };
    }
    this.conn = v.mainConnectionID === undefined || v.mainConnectionID === null ? -1 : v.mainConnectionID;
    return { ok: true };
};
CarAudio.prototype.amDisconnect = async function () {
    const id = this.conn;
    this.conn = null;
    if (id === null || id === undefined || id === -1) return;
    const p = this.px[CC + '|' + this.ccInstance()];
    if (!p) return;
    const r = await this.call(CC, p, 'disconnect', { mainConnectionID: id }, 5000);
    this.say('disconnect ' + id + ' -> ' + (r.ok ? show(r.value) : 'failed: ' + r.error));
};
/* The car's generic media player, as iDrive 7: connect, then playFile. Its own state and time drive the picture. */
CarAudio.prototype.playBmw = async function (plan, file, at) {
    const c = await this.amConnect();
    if (!c.ok) return { ok: false, msg: c.error };
    const p = await this.proxy(MP, plan.inst);
    if (!p) return { ok: false, msg: 'the car\'s media player could not be reached' };
    this.hear(MP, p);
    const r = await this.call(MP, p, 'playFile', { path: file, languageCode: LANGUAGE_CODE });
    this.say('playFile ' + path.basename(file) + ' -> ' + (r.ok ? show(r.value) : 'failed: ' + r.error));
    if (!r.ok) return { ok: false, msg: 'the car\'s media player refused the file: ' + r.error };
    const v = r.value || {};
    if (v.EntError !== undefined && v.EntError !== 'OK') return { ok: false, msg: 'the car\'s media player answered ' + v.EntError };
    if (at > 1500) await this.call(MP, p, 'setTime', { newTimeElapsed: Math.floor(at) }, 4000);
    this.active = { plan: plan, p: p, iface: MP, file: file };
    return { ok: true, name: 'the car\'s media player (' + plan.inst + ')', caps: { holdsPosition: false } };
};
/* The car's dynamic media player: a token, then a playlist with our file, then a start. */
CarAudio.prototype.playDyn = async function (plan, file, at, info) {
    const p = await this.proxy(DYN, plan.inst);
    if (!p) return { ok: false, msg: 'the car\'s dynamic media player could not be reached' };
    this.hear(DYN, p);
    const f = await this.focus(plan, p);
    if (!f.ok) return { ok: false, msg: f.error };
    const made = await this.playlist(p, file, info);
    if (!made.ok) { await this.dropFocus(p); return { ok: false, msg: made.error }; }
    const started = await this.start(p);
    this.active = { plan: plan, p: p, iface: DYN, file: file };
    if (!started.ok) { await this.release(); return { ok: false, msg: started.error }; }
    return { ok: true, name: 'the car\'s dynamic media player (' + plan.inst.replace(/^DynamicMediaPlayer/, '') + ')',
        caps: { holdsPosition: false }, combo: started.how };
};
/**
 * The audio focus. On the car every guess at its arguments was answered BAD_ARGUMENT, so they are built from the
 * interface's own description instead: each argument gets a value of the type the car declares for it, and an
 * argument the description does not name is not sent at all. That is a handful of tries, not hundreds.
 */
CarAudio.prototype.focus = async function (plan, p) {
    if (this.token) return { ok: true };
    const cfg = this.cfg[DYN];
    const args = argsOf(cfg, 'getAudioFocus');
    const ids = [this.appId, this.title, String(process.getuid ? process.getuid() : 0)];
    const timers = [this.o.heartbeatTimer || 10000, 0];
    const tries = [];
    if (!args) {
        // no description to go by: the three names the SDK's own call is written with
        ids.forEach((id) => timers.forEach((hb) => tries.push({ clientId: id, clientName: this.title, timeOutHeartBeatTimer: hb })));
    } else {
        this.say('getAudioFocus takes ' + args.map((a) => a.n + ':' + a.t).join(', '));
        const values = (a) => {
            if (isEnum(a.t)) { const keys = a.e && typeof a.e === 'object' ? Object.keys(a.e) : []; return keys.length ? keys : [0]; }
            if (isNum(a.t)) {
                if (/time|timer|heart|beat/i.test(String(a.n))) return timers;
                if (/client|app|id/i.test(String(a.n))) return [process.getuid ? process.getuid() : 0, 1, 0];
                return [0];
            }
            if (isText(a.t)) {
                if (/name/i.test(String(a.n)) && !/client/i.test(String(a.n))) return [this.title, this.appId];
                return ids;
            }
            return [null];
        };
        const grid = args.map(values);
        const walk = (i, acc) => {
            if (tries.length >= (this.o.focusTries || 24)) return;
            if (i === args.length) { const o = {}; args.forEach((a, k) => { o[a.n] = acc[k]; }); tries.push(o); return; }
            grid[i].forEach((v) => walk(i + 1, acc.concat([v])));
        };
        walk(0, []);
    }
    let last = null;
    for (const a of tries) {
        const r = await this.call(DYN, p, 'getAudioFocus', a, 5000);
        if (!r.ok) { last = r.error; this.say('getAudioFocus ' + show(a, 110) + ' failed: ' + r.error); continue; }
        const v = r.value || {};
        const err = v.dynMediaPlayerError;
        if (v.token !== undefined && v.token !== null && (err === undefined || err === 'OK')) {
            this.say('getAudioFocus ' + show(a, 110) + ' -> ' + show(v, 120));
            this.token = v.token;
            this.keepFocus(p, a);
            const conn = await this.value(DYN, p, 'connectionState');
            if (conn !== undefined) this.say('its connectionState: ' + show(conn));
            return { ok: true };
        }
        last = String(err === undefined ? show(v, 80) : err);
        this.say('getAudioFocus ' + show(a, 110) + ' -> ' + last);
        if (last !== 'BAD_ARGUMENT') break;     // (another answer is not about the arguments)
    }
    return { ok: false, error: 'the car gave this app no audio focus (' + (last || 'nothing answered') + ')' };
};
CarAudio.prototype.keepFocus = function (p, asked) {
    const every = Math.max(500, Math.min(this.o.heartbeatMs || 1500, (asked && asked.timeOutHeartBeatTimer > 900 ? Math.floor(asked.timeOutHeartBeatTimer / 3) : 1e9)));
    if (this.beat) clearInterval(this.beat);
    this.beat = setInterval(() => {
        if (!this.token) return;
        this.call(DYN, p, 'heartBeat', { token: this.token }, 2500).then((r) => {
            if (!r.ok && !this.beatSaid) { this.beatSaid = true; this.say('heartBeat failed: ' + r.error); }
        });
    }, every);
    if (this.beat.unref) this.beat.unref();
};
CarAudio.prototype.dropFocus = async function (p) {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    this.beatSaid = false;
    if (!this.token) return;
    const tok = this.token;
    this.token = null;
    if (p) await this.call(DYN, p, 'releaseAudioFocus', { token: tok }, 4000);
};
/* The playlist with our file. The item is written as the interface's own description says its metadata is. */
CarAudio.prototype.playlist = async function (p, file, info) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { /* unknown: left out */ }
    const forms = [
        { name: 'named values', make: () => [{ pos: 1, id: Buffer.from(String((info && info.id) || 'beemtube').slice(0, 11)), metadata: meta(file, size, (v) => ({ stringValue: v }), (v) => ({ numeric: v })) }] },
        { name: 'plain values', make: () => [{ pos: 1, id: Buffer.from(String((info && info.id) || 'beemtube').slice(0, 11)), metadata: meta(file, size, (v) => v, (v) => v) }] },
        { name: 'named values, the name only', make: () => [{ pos: 1, id: Buffer.from(String((info && info.id) || 'beemtube').slice(0, 11)), metadata: [{ key: 'FILE_NAME', value: { stringValue: file } }] }] },
    ];
    let last = null;
    for (const f of forms) {
        const r = await this.call(DYN, p, 'createPlaylist', { token: this.token, newPlaylist: f.make() }, 6000);
        if (!r.ok) { last = r.error; this.say('createPlaylist (' + f.name + ') failed: ' + r.error); continue; }
        const v = r.value || {};
        const err = v.dynMediaPlayerError;
        this.say('createPlaylist (' + f.name + ') -> ' + show(v, 120));
        if (err === undefined || err === 'OK') return { ok: true, form: f.name };
        last = String(err);
        if (err === 'TOKEN_NOT_VALID' || err === 'CONNECTION_STATE_NOT_VALID') break;
    }
    return { ok: false, error: 'the car\'s dynamic media player did not take our file (' + (last || 'no answer') + ')' };
};
function meta(file, size, str, num) {
    const m = [{ key: 'FILE_NAME', value: str(file) }];
    if (size) m.push({ key: 'FILE_SIZE', value: num(size) });
    return m;
}
/* It has our playlist: now make it play. */
CarAudio.prototype.start = async function (p) {
    const ways = [
        { how: 'auto', run: () => Promise.resolve({ ok: true }) },
        { how: 'pos', run: () => this.call(DYN, p, 'setCurrentItemPositionAndTime', { token: this.token, newPosition: 1, newTimeElapsed: 0 }, 4000) },
        { how: 'play', run: () => this.button('PLAY') },
    ];
    for (const w of ways) {
        await w.run();
        const played = await this.waitPlay(p, w.how === 'auto' ? 1800 : 2500);
        if (played) { this.say('it plays (started ' + w.how + ')'); return { ok: true, how: w.how }; }
    }
    const err = await this.value(DYN, p, 'playbackErrorEvent');
    return { ok: false, error: 'the car took our file and did not play it' + (err ? ' (' + show(err, 80) + ')' : '') };
};
CarAudio.prototype.waitPlay = async function (p, ms) {
    const end = Date.now() + ms;
    for (;;) {
        if (this.playing) return true;
        const st = await this.value(DYN, p, 'playerState');
        if (isPlaying(st)) return true;
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 200));
    }
};
/* The player's own words, passed to the service as the iDrive 7 player's are. */
CarAudio.prototype.hear = function (iface, p) {
    this.listen(iface, p, 'playerState', (v) => {
        const s = typeof v === 'string' ? v : (v && v.state) || show(v, 40);
        this.playing = isPlaying(s);
        this.ev('state', String(s));
    });
    this.listen(iface, p, 'currentItemTime', (v) => {
        if (!v || typeof v.elapsed !== 'number') return;
        // iDrive 7's player counts in milliseconds; this one's unit is not written down anywhere. Where it says a
        // length, the length of the video we were handed tells which it is, once and for the rest of the play.
        if (!this.msUnit && v.total > 1 && this.durationMs > 1000) {
            if (Math.abs(v.total - this.durationMs) < this.durationMs * 0.1) this.msUnit = 'ms';
            else if (Math.abs(v.total * 1000 - this.durationMs) < this.durationMs * 0.1) this.msUnit = 's';
            if (this.msUnit) this.say('its time comes in ' + (this.msUnit === 's' ? 'seconds' : 'milliseconds') + ' (it says ' + v.total + ' for a video of ' + this.durationMs + ' ms)');
        }
        const k = this.msUnit === 's' ? 1000 : 1;
        this.ev('time', { elapsed: v.elapsed * k, total: (v.total > 1 ? v.total : 0) * k });
    });
    this.listen(iface, p, 'playbackErrorEvent', (v) => { if (v && v.event && !/NO_ERROR/.test(String(v.event))) this.ev('error', v); });
};

/* ------------------------------------------------------------------ what the service asks for */

CarAudio.prototype.onRequest = async function (m) {
    const reply = (o) => this.send(Object.assign({ cmd: 'audio_res', req: m.req }, o));
    try {
        if (m.op === 'plans') {
            const plans = await this.plans();
            return reply({ ok: true, plans: plans.map((p) => ({ key: p.key, name: p.name, holdsPosition: !!p.holdsPosition })), report: this.report.slice(0, 60) });
        }
        if (m.op === 'play') {
            await this.release();
            const plan = (await this.plans()).filter((p) => p.key === m.plan)[0];
            if (!plan) return reply({ ok: false, msg: 'this car has no such way to sound any more' });
            if (!m.file || typeof m.file !== 'string') return reply({ ok: false, msg: 'no file' });
            const at = Math.max(0, Math.floor(m.at || 0));
            this.playing = false;
            this.msUnit = null;
            this.durationMs = (m.info && m.info.durationMs > 0) ? m.info.durationMs : 0;
            let r;
            if (plan.key === 'bmw') r = await this.playBmw(plan, m.file, at);
            else if (plan.key === 'amconnect') { const c = await this.amConnect(); r = c.ok ? { ok: true, name: plan.name, caps: { holdsPosition: true } } : { ok: false, msg: c.error }; if (r.ok) this.active = { plan: plan }; }
            else r = await this.playDyn(plan, m.file, at, m.info || {});
            if (!r.ok) await this.release();
            return reply(r);
        }
        if (m.op === 'replay') {
            const a = this.active;
            if (!a) return reply({ ok: false, msg: 'nothing plays' });
            if (a.iface === MP) {
                const r = await this.call(MP, a.p, 'playFile', { path: m.file, languageCode: LANGUAGE_CODE });
                if (!r.ok) return reply({ ok: false, msg: r.error });
                if (m.at > 0) await this.call(MP, a.p, 'setTime', { newTimeElapsed: Math.floor(m.at) }, 4000);
                a.file = m.file;
                return reply({ ok: true });
            }
            if (a.iface === DYN) {
                const made = await this.playlist(a.p, m.file, m.info || {});
                if (!made.ok) return reply({ ok: false, msg: made.error });
                await this.start(a.p);
                a.file = m.file;
                return reply({ ok: true });
            }
            return reply({ ok: true });     // (the audio manager's connection alone: the service's own player swaps the file)
        }
        if (m.op === 'button') { const on = await this.button(m.button); return reply({ ok: true, on: on }); }
        if (m.op === 'seek') {
            const a = this.active;
            if (!a || !a.p) return reply({ ok: true });
            const ms = Math.max(0, Math.floor(m.at || 0));
            const r = a.iface === MP ? await this.call(MP, a.p, 'setTime', { newTimeElapsed: ms }, 4000)
                : await this.call(DYN, a.p, 'setCurrentItemPositionAndTime', { token: this.token, newPosition: 1, newTimeElapsed: ms }, 4000);
            return reply({ ok: !!r.ok, msg: r.ok ? undefined : r.error });
        }
        if (m.op === 'release') { await this.release(); return reply({ ok: true }); }
        return reply({ ok: false, msg: 'unknown audio request ' + m.op });
    } catch (e) {
        this.log.warn('car audio: ' + m.op + ': ' + errText(e));
        try { return reply({ ok: false, msg: errText(e) }); } catch (e2) { return undefined; }
    }
};
CarAudio.prototype.button = async function (b) {
    const a = this.active;
    if (!a || !a.p) return true;
    if (a.iface === MP) {
        const r = await this.call(MP, a.p, 'sendButtonEvent', { button: b, action: 'PRESS' }, 4000);
        return !!r.ok;
    }
    const press = await this.call(DYN, a.p, 'sendButtonEventDirect', { token: this.token, button: b, action: 'PRESS' }, 4000);
    await new Promise((r) => setTimeout(r, 80));
    await this.call(DYN, a.p, 'sendButtonEventDirect', { token: this.token, button: b, action: 'RELEASE' }, 4000);
    return !!press.ok;
};
/* Everything of ours given back to the car. Safe to call twice, and it never throws. */
CarAudio.prototype.release = async function () {
    const a = this.active;
    this.active = null;
    this.playing = false;
    try {
        if (a && a.iface === MP) await this.call(MP, a.p, 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 4000);
        if (a && a.iface === DYN) {
            await this.call(DYN, a.p, 'createPlaylist', { token: this.token, newPlaylist: [] }, 4000);
            await this.dropFocus(a.p);
        }
        await this.dropFocus(a && a.p);
        await this.amDisconnect();
    } catch (e) { this.log.warn('car audio: release: ' + errText(e)); }
};
/* Said once at the start, so the service knows there is an app that can ask the car, and the Diagnostics page
 * has what this head unit offers even before a video is played. */
CarAudio.prototype.hello = function (version) {
    this.send({ cmd: 'audio_hello', version: version || '', report: this.report.slice(0, 40) });
};

module.exports = { CarAudio, tryFor, argsOf, instancesOf, isPlaying, CC, MP, DYN };
