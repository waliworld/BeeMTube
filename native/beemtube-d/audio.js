'use strict';
/**
 * audio.js - where BeeMTube's sound comes from, and the clock the picture follows.
 *
 * On iDrive 7 the car's own media player plays our file and its clock drives everything (ytd.js, Audio).
 * That player is not offered to this service on iDrive 8, and the service is the wrong one to ask: the car's
 * media services answer a *registered app*, not a root daemon nobody provisioned. So here a play is built the
 * other way round:
 *
 *   1. the picture starts at once, on this service's own clock (ClockSink). Nothing of the car is touched, so
 *      nothing can go wrong with it, and the driver sees the video the moment it is ready;
 *   2. the sound is looked for beside it, with a time limit, and slipped under the playing video when it is
 *      found (attach). The way that worked is kept for the next play (state/sound.json);
 *   3. if nothing sounds, the video plays on in silence and says so. A play never ends because of the sound.
 *
 * A sink is one way to make sound (or none). They all speak the iDrive 7 player's language - state events
 * 'PLAYER_STATE_PLAY' / 'PLAYER_STATE_PAUSE' / 'PLAYER_STATE_STOP', a time of { elapsed, total } in
 * milliseconds - because the daemon's state machine was written for it and is proven there:
 *
 *   sink.caps                  { sound, holdsPosition, reportsTime }
 *   sink.play(file, atMs)      resolves once it plays; rejects with what to tell the driver
 *   sink.replay(file, atMs)    the same sound swapped under it (the audio head -> the whole file)
 *   sink.button(b)             'PLAY' | 'PAUSE' | 'STOP'  (PLAY resolves false where the sound did not go on)
 *   sink.seek(ms)
 *   sink.release()
 *
 * The sinks:
 *   ClockSink    no sound: this service's own clock. Always there, asks the car nothing.
 *   AppSink      the car's own player, asked by BeeMTube's app over the control socket. The app is the
 *                registered OAP app; it holds BMW's SDK and the car's media interfaces are provisioned for
 *                it, so it is the one the car answers. Whatever it tries runs in the app's process, not here.
 *   OwnPlaySink  our own player: ytaud decodes the file, ytalsa.py writes the samples to the car's audio
 *                router (the app asks the audio manager to connect our source first).
 *
 * Sinks(opts, handlers) is what the daemon holds. It keeps the surface the iDrive 7 Audio has, so the daemon
 * drives both the same way.
 *
 * Node 8 (the unit's /usr/bin/node). No dependency.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const STATE_V = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (dev) => String(dev).replace(/^plug:smartx:/, '');
const errText = (e) => String((e && e.message) || e);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(file, v) {
    const tmp = file + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
    } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* none */ } return false; }
}
function withTimeout(p, ms, what) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(what + ' timed out after ' + ms + ' ms')), ms);
        Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

/* ------------------------------------------------------------------ no sound: our own clock */

/**
 * The picture's clock while nothing sounds. It ticks four times a second from where the play is, and only
 * while the gate lets it: with no sound the picture may not run ahead of what is fetched, or the progress bar
 * would promise a video that is not there yet.
 */
function ClockSink(opts, handlers, gate) {
    this.o = opts;
    this.h = handlers;
    this.gate = gate || (() => true);
    this.key = 'silent';
    this.name = 'no sound (the picture plays on this service\'s clock)';
    this.caps = { sound: false, holdsPosition: true, reportsTime: true };
    this.at = 0;
    this.total = 0;
    this.timer = null;
    this.running = false;
}
ClockSink.prototype.play = function (file, atMs, info) {
    this.at = Math.max(0, Math.floor(atMs || 0));
    this.total = (info && info.durationMs > 1) ? info.durationMs : 0;
    this.start();
    return Promise.resolve();
};
ClockSink.prototype.replay = function (file, ms) {
    if (ms > 0) this.at = Math.floor(ms);
    return Promise.resolve();
};
ClockSink.prototype.start = function () {
    if (this.timer) return;
    this.running = true;
    this.last = Date.now();
    this.h.state('PLAYER_STATE_PLAY');
    this.timer = setInterval(() => {
        const now = Date.now(), step = now - this.last;
        this.last = now;
        if (!this.running) return;
        if (!this.gate(this.at)) return;                 // the video is not fetched that far: hold here
        this.at += step;
        const total = this.total > 1 ? this.total : this.at + 2000;
        if (this.total > 1 && this.at >= this.total) {    // the end: as the car's player says it
            this.at = this.total;
            this.h.time({ elapsed: this.at, total: total });
            this.stopTicking();
            this.h.state('PLAYER_STATE_STOP');
            return;
        }
        this.h.time({ elapsed: this.at, total: total });
    }, 250);
    if (this.timer.unref) this.timer.unref();
};
ClockSink.prototype.stopTicking = function () {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
};
ClockSink.prototype.button = function (b) {
    if (b === 'PLAY') { this.start(); return Promise.resolve(true); }
    this.stopTicking();
    return Promise.resolve();
};
ClockSink.prototype.seek = function (ms) { this.at = Math.max(0, Math.floor(ms || 0)); return Promise.resolve(); };
ClockSink.prototype.release = function () { this.stopTicking(); return Promise.resolve(); };
ClockSink.prototype.where = function () { return this.at; };

/* ------------------------------------------------------------------ the car's own player, asked by the app */

/**
 * The app does the talking. This sink is a handle on it: every step is one request over the control socket
 * ({ ev: 'audio', op: ... } out, { cmd: 'audio_res' } back), and the app sends the player's state and time as
 * they come ({ cmd: 'audio_ev' }). Nothing of BMW's is loaded in this process, so nothing of BMW's can take it
 * (or the app) down from here: a plan the app cannot carry out comes back as a refusal with its reason.
 *
 * plan: what the app should use - 'bmw' (the car's generic media player as iDrive 7 uses it) or 'dyn' (the
 * car's dynamic media player: the audio focus and a playlist).
 */
function AppSink(sinks, plan, info) {
    this.s = sinks;
    this.o = sinks.o;
    this.plan = plan;
    this.key = 'app:' + plan.key;
    this.name = plan.name;
    this.caps = { sound: true, holdsPosition: !!plan.holdsPosition, reportsTime: plan.reportsTime !== false };
    this.active = false;
}
AppSink.prototype.ask = function (op, args, ms) {
    return this.s.ask(Object.assign({ op: op, plan: this.plan.key }, args || {}), ms);
};
AppSink.prototype.play = async function (file, atMs, info) {
    const r = await this.ask('play', { file: file, at: Math.max(0, Math.floor(atMs || 0)), info: info || {} },
        this.o.appPlayMs || 20000);
    if (!r.ok) throw Object.assign(new Error(this.name + ': ' + (r.msg || 'refused')), { short: r.msg || 'refused' });
    // what the app learned about this plan on the way (the player's own words): kept for the page
    if (r.name) this.name = r.name;
    if (r.caps) this.caps = Object.assign(this.caps, r.caps);
    this.combo = r.combo || null;
};
AppSink.prototype.replay = async function (file, ms) {
    const r = await this.ask('replay', { file: file, at: Math.max(0, Math.floor(ms || 0)) }, this.o.appPlayMs || 20000);
    if (!r.ok) throw new Error(this.name + ': ' + (r.msg || 'refused'));
};
AppSink.prototype.button = async function (b) {
    const r = await this.ask('button', { button: b }, 8000);
    return r.ok ? (r.on === undefined ? true : !!r.on) : false;
};
AppSink.prototype.seek = async function (ms) { await this.ask('seek', { at: Math.max(0, Math.floor(ms || 0)) }, 8000); };
AppSink.prototype.release = async function () {
    this.active = false;
    try { await this.ask('release', {}, 8000); } catch (e) { /* the app is gone: the car drops our focus with it */ }
};

/* ------------------------------------------------------------------ our own player on the car's audio router */

/**
 * ytaud decodes the file, ytalsa.py writes the samples to one device of the car's audio router and says
 * whether the car takes them at the pace of time - which is the only honest test that something plays them.
 * The router only reads a device whose source the audio manager has connected, and that connection is the
 * app's to ask for (plan 'amconnect'), so this sink is tried only where the app could ask.
 */
function OwnPlaySink(sinks, dev) {
    this.s = sinks;
    this.o = sinks.o;
    this.dev = dev;
    this.key = 'own:' + dev;
    this.name = 'this service\'s own player on "' + short(dev) + '"';
    this.caps = { sound: true, holdsPosition: true, reportsTime: true };
    this.child = null;
    this.active = false;
    this.info = {};
}
OwnPlaySink.prototype.cmd = function () {
    return this.o.alsaCmd || ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(__dirname, 'ytalsa.py')];
};
OwnPlaySink.prototype.spawn = function (file, startMs) {
    const cmd = this.cmd();
    const args = cmd.slice(1).concat(['play', '--device', this.dev, '--decoder', this.o.ytaud || path.join(__dirname, 'ytaud'),
        '--file', file, '--start-ms', String(Math.max(0, Math.floor(startMs || 0)))]);
    let child;
    try {
        child = cp.spawn(cmd[0], args, { cwd: '/', env: this.o.alsaEnv || {}, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
        this.err = 'could not be started: ' + errText(e);
        return;
    }
    this.child = child;
    child.stdin.on('error', () => { /* it died: its exit says so */ });
    readline.createInterface({ input: child.stderr }).on('line', (l) => {
        if (this.child === child) { this.lastErr = l; this.s.say('ytalsa: ' + String(l).slice(0, 240)); }
    });
    readline.createInterface({ input: child.stdout }).on('line', (l) => {
        if (this.child !== child) return;
        let m;
        try { m = JSON.parse(l); } catch (e) { return; }
        this.onLine(m);
    });
    child.on('error', (e) => { if (this.child === child) this.onLine({ ev: 'error', msg: 'could not be started: ' + e.message }); });
    child.on('exit', (code, sig) => { if (this.child === child) { this.child = null; this.onLine({ ev: 'exit', code: sig || code }); } });
};
OwnPlaySink.prototype.to = function (line) {
    if (!this.child) return;
    try { this.child.stdin.write(line + '\n'); } catch (e) { /* dying */ }
};
OwnPlaySink.prototype.onLine = function (m) {
    const h = this.s.h;
    if (m.ev === 'time') {
        this.last = m;
        if (this.active) h.time({ elapsed: m.elapsed, total: m.total > 1 ? m.total : (this.info.durationMs > 1 ? this.info.durationMs : m.elapsed + 2000) });
    } else if (m.ev === 'state') {
        if (this.active) h.state(m.state);
    } else if (m.ev === 'resumed') {
        this.resumed = !!m.ok;
    } else if (m.ev === 'flow') {
        this.flow = m;
        if (this.waiter) this.waiter();
    } else if (m.ev === 'open') {
        this.s.say('opened ' + short(this.dev) + ': ' + m.rate + ' Hz, ' + m.channels + ' ch, buffer ' + m.buffer);
    } else if (m.ev === 'error' || m.ev === 'exit') {
        if (m.ev === 'error') this.err = String(m.msg || 'failed');
        else if (!this.err && !this.ended && m.code !== 0) this.err = 'ended (' + m.code + ')' + (this.lastErr ? ': ' + String(this.lastErr).trim().slice(0, 160) : '');
        if (m.ev === 'exit' && !this.err) this.ended = true;
        if (this.waiter) this.waiter();
        if (this.active && this.err) { const e = this.err; this.active = false; h.error({ event: 'our own player: ' + e }); return; }
        // it ended on its own while it was playing (the file ran out, or the router dropped us): the daemon takes
        // this as the car's player stopping - the end of the video near its end, the sound let go otherwise
        if (this.active && m.ev === 'exit') { this.active = false; h.state('PLAYER_STATE_STOP'); }
    }
};
/* 'flows' (the car takes the samples as time passes), 'stalls' (it takes none: nothing plays them), or why not. */
OwnPlaySink.prototype.verdict = async function (ms) {
    const end = Date.now() + ms;
    while (!this.flow && !this.err && !this.ended && Date.now() < end && !this.s.cancelled) {
        await new Promise((r) => { this.waiter = r; setTimeout(r, 200); });
    }
    this.waiter = null;
    if (this.err) return { out: 'error', why: this.err };
    if (this.ended) return { out: 'error', why: 'it ended at once' };
    if (!this.flow) return { out: 'error', why: 'it said nothing in ' + Math.round(ms / 1000) + ' s' };
    return { out: this.flow.verdict, why: this.flow };
};
OwnPlaySink.prototype.play = async function (file, atMs, info) {
    this.info = info || {};
    // the router reads a device only while the audio manager has its source connected to a sink
    if (this.s.o.amConnect !== false) {
        const c = await this.s.amConnect();
        if (!c.ok) throw Object.assign(new Error(this.name + ': ' + c.error), { short: c.error });
    }
    this.flow = null; this.err = null; this.ended = false; this.lastErr = null;
    this.spawn(file, atMs || 0);
    if (!this.child && this.err) throw Object.assign(new Error(this.err), { short: this.err });
    const v = await this.verdict(this.o.ownStartMs || 8000);
    const said = v.out === 'flows' ? 'takes the samples as time passes'
        : v.out === 'stalls' ? 'takes no samples (nothing plays them)'
            : v.out === 'fast' ? 'swallows the samples faster than time (they go nowhere)'
                : 'failed: ' + String(v.why).slice(0, 160);
    this.s.say(short(this.dev) + ': ' + said);
    if (v.out !== 'flows') {
        this.kill();
        const why = v.out === 'error' ? 'failed (' + String(v.why).slice(0, 100) + ')' : 'is not played by the car (' + v.out + ')';
        throw Object.assign(new Error(this.name + ' ' + why), { short: why });
    }
};
OwnPlaySink.prototype.replay = async function (file, ms) {
    this.to('file ' + JSON.stringify(file) + (ms > 0 ? ' ' + Math.floor(ms) : ''));
};
OwnPlaySink.prototype.button = async function (b) {
    if (b === 'STOP' || b === 'PAUSE') { this.to('pause'); return undefined; }
    if (b !== 'PLAY') return undefined;
    this.resumed = null;
    this.to('resume');
    const end = Date.now() + (this.o.ownResumeMs || 3500);
    while (this.resumed === null && this.child && Date.now() < end) await sleep(40);
    return !!this.child && this.resumed !== false;
};
OwnPlaySink.prototype.seek = async function (ms) { this.to('seek ' + Math.max(0, Math.floor(ms || 0))); };
OwnPlaySink.prototype.kill = function () {
    const c = this.child;
    this.child = null;
    if (!c) return;
    try { c.stdin.write('quit\n'); c.stdin.end(); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1200);
    c.on('exit', () => clearTimeout(t));
};
OwnPlaySink.prototype.release = async function () {
    this.active = false;
    this.kill();
};

/* ------------------------------------------------------------------ the sinks together */

/**
 * Sinks(opts, handlers)
 *   handlers  { time, state, error, note }  the daemon's, as the iDrive 7 player's events reach it
 *   .gate(fn)         what ClockSink may run up to (the video fetched so far)
 *   .bridge(b)        the link to the app: { ask(msg, ms) -> Promise<reply>, plans() -> [plan], up() }
 *   .play(file, info)     starts the picture's clock at once and looks for sound beside it
 *   .replay/.button/.seek/.release/.holds   as the daemon drives the iDrive 7 player
 *   .nosound()        the driver hears nothing through what plays: leave it out, look on
 *   .reset()          forget everything kept
 *   .lines()          the Diagnostics page's own lines
 */
function Sinks(opts, handlers) {
    this.o = opts;
    this.h = {
        time: (v) => { if (v && typeof v.elapsed === 'number') this.lastTime = { elapsed: v.elapsed, total: v.total, at: Date.now() }; this.safe('time', v); },
        state: (v) => this.safe('state', v),
        error: (v) => this.safe('error', v),
    };
    this.lastTime = null;
    this.held = false;         // the daemon stopped or paused what plays
    this.assistT = null;
    this.out = handlers;
    this.file = path.join(this.o.stateDir || '/var/opt/beemtube-d/state', 'sound.json');
    this.state = this.load();
    this.clock = null;
    this.sound = null;         // the sound sink that plays, if one does
    this.link = null;          // the app bridge
    this.gen = 0;              // bumps at every play: a search of an older one stops at its next step
    this.searchingGen = null;  // the play whose search is in flight
    this.cancelled = false;
    this.story = [];           // this play's lines, for the page
    this.runs = [];            // the last plays' stories
    this.at = 0;               // where the play is (the daemon tells us at each attach)
    this.want = null;          // { file, info } of the play
    this.dropped = {};         // ways that fell away during this play, and how often
}
Sinks.prototype.load = function () {
    let s = readJson(this.file);
    if (!s || typeof s !== 'object' || s.v !== STATE_V) s = { v: STATE_V };
    if (!s.silent || typeof s.silent !== 'object') s.silent = {};
    if (s.ver !== (this.o.version || '?')) { s.ver = this.o.version || '?'; s.kept = s.kept || null; }
    return s;
};
Sinks.prototype.save = function () { return writeJson(this.file, this.state); };
/* A handler of the daemon's: whatever it throws must not end the play. */
Sinks.prototype.safe = function (k, v) {
    try { this.out[k](v); } catch (e) { this.o.log('audio: the daemon\'s ' + k + ' handler: ' + ((e && e.stack) || e)); }
};
Sinks.prototype.say = function (t) {
    this.o.log('audio: ' + t);
    if (this.story.length < 160) this.story.push('+' + ((Date.now() - (this.startedAt || Date.now())) / 1000).toFixed(1) + 's ' + String(t).slice(0, 500));
};
Sinks.prototype.note = function (t) {
    if (this.out.note) { try { this.out.note(t); } catch (e) { /* the app's screen only */ } }
};
Sinks.prototype.gate = function (fn) { this.gateFn = fn; };
Sinks.prototype.bridge = function (b) { this.link = b; };
/* One request to the app; never throws. */
Sinks.prototype.ask = async function (msg, ms) {
    if (!this.link || !this.link.up()) return { ok: false, msg: 'the BeeMTube app is not connected' };
    try { return await withTimeout(this.link.ask(msg), ms || 10000, 'the app'); } catch (e) { return { ok: false, msg: errText(e) }; }
};
Sinks.prototype.active = function () { return this.sound || this.clock; };
Sinks.prototype.caps = function () { const a = this.active(); return a ? a.caps : { sound: false, holdsPosition: true, reportsTime: true }; };
Sinks.prototype.holds = function () { const a = this.active(); return !!(a && a.caps.holdsPosition); };
/* Which way plays, for the app's screen: { route, name, kept, silent, searching }. */
Sinks.prototype.status = function () {
    const a = this.sound, looking = this.searchingGen === this.gen && this.gen > 0;
    return {
        route: a ? a.key : 'silent',
        name: a ? a.name : (looking ? 'looking for sound...' : 'no sound on this car yet'),
        kept: !!(this.state.kept && a && this.state.kept.key === a.key),
        silent: Object.keys(this.state.silent).length,
        searching: looking,
    };
};

/**
 * A play. The picture's clock starts here and the daemon goes on at once; the sound is looked for beside it.
 * atMs: where the play starts (a resume point), file: the audio file as it is now.
 */
Sinks.prototype.play = async function (file, info, atMs) {
    const pi = info || this.playInfo || {};      // (the daemon sets playInfo before a play, as iDrive 7's Audio takes it)
    this.gen++;                                  // a search of the play before stops at its next step
    this.dropped = {};
    this.am = false;
    this.cancelled = false;
    this.startedAt = Date.now();
    this.story = [];
    this.want = { file: file, info: pi };
    this.at = Math.max(0, Math.floor(atMs === undefined ? (pi.at || 0) : atMs));
    this.clock = new ClockSink(this.o, this.h, (ms) => (this.gateFn ? this.gateFn(ms) : true));
    await this.clock.play(file, this.at, pi);
    this.search();            // (not awaited: the picture does not wait for the sound)
    return undefined;
};
/* The sound, looked for in the background: one search a play, and a search of an older play stops at its next
 * step (a new play, "No sound?" or a sound that fell away each start their own). */
Sinks.prototype.search = function () {
    if (this.searchingGen === this.gen || this.sound || this.cancelled || this.o.sound === false) return undefined;
    const gen = this.searchingGen = this.gen;
    this.searchNow(gen)
        .catch((e) => { this.o.log('audio: the search for sound: ' + ((e && e.stack) || e)); })
        .then(() => { if (this.searchingGen === gen) this.searchingGen = null; });
    return undefined;
};
Sinks.prototype.searchNow = async function (gen) {
    const end = Date.now() + (this.o.soundSearchMs || 45000);
    const over = () => gen !== this.gen || this.cancelled || !!this.sound || !this.want;
    let asked = false;
    for (;;) {
        if (over()) return;
        const cand = await this.candidates(asked);
        asked = true;
        if (over()) return;
        if (!cand.length) { this.say('no way to sound to try on this car'); this.done('nothing to try'); return; }
        for (const c of cand) {
            if (over()) return;
            if (Date.now() > end) { this.say('the search for sound gave up for this play (' + Math.round((this.o.soundSearchMs || 45000) / 1000) + ' s)'); this.done('gave up'); return; }
            if (this.state.silent[c.key]) { this.say(c.key + ' left out: it played without sound'); continue; }
            // a way that fell away twice during this play is not tried a third time: the car means it
            if (this.dropped[c.key] >= 2) { this.say(c.key + ' left out for this video: its sound fell away twice'); continue; }
            this.note('Looking for sound: ' + c.name + '...');
            const ok = await this.tryOne(c, gen);
            if (ok) return;
        }
        this.done('nothing played');
        return;
    }
};
/* Everything that could sound on this car, the likeliest first. */
Sinks.prototype.candidates = async function (asked) {
    const out = [], o = this.o;
    const plans = await this.plans(asked);
    const mk = {
        app: (p) => ({ key: 'app:' + p.key, name: p.name, make: () => new AppSink(this, p) }),
        own: (dev) => ({ key: 'own:' + dev, name: 'our own player on "' + short(dev) + '"', make: () => new OwnPlaySink(this, dev) }),
    };
    // every plan of the app's that makes sound by itself; 'amconnect' is not one - it only gets our source
    // connected, which is what our own player needs before the router reads anything of ours
    plans.filter((p) => p.key !== 'amconnect').forEach((p) => out.push(mk.app(p)));
    if (o.own !== false && plans.some((p) => p.key === 'amconnect')) {
        (await this.devices()).forEach((d) => out.push(mk.own(d)));
    }
    // the way that worked last time goes first
    const k = this.state.kept && this.state.kept.key;
    if (k) {
        const i = out.findIndex((c) => c.key === k);
        if (i > 0) out.unshift(out.splice(i, 1)[0]);
    }
    return out;
};
/* What the app says it can do. Asked once a play (and once more when the app reconnects). */
Sinks.prototype.plans = async function (asked) {
    if (asked && this.plansMemo) return this.plansMemo;
    const r = await this.ask({ op: 'plans' }, this.o.appPlansMs || 15000);
    if (!r.ok || !Array.isArray(r.plans)) {
        this.say('the app offers no way to the car\'s player: ' + (r.msg || 'no answer'));
        this.plansMemo = [];
        return this.plansMemo;
    }
    this.appReport = Array.isArray(r.report) ? r.report : [];
    this.plansMemo = r.plans.filter((p) => p && typeof p.key === 'string' && typeof p.name === 'string');
    this.say('the app can try: ' + (this.plansMemo.map((p) => p.key).join(', ') || 'nothing'));
    return this.plansMemo;
};
/* The router's devices worth a try, read from the car's own files (nothing is opened). */
Sinks.prototype.devices = async function () {
    if (this.devs) return this.devs;
    this.devs = [];
    const cmd = this.o.alsaCmd || ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(__dirname, 'ytalsa.py')];
    const dec = this.o.ytaud || path.join(__dirname, 'ytaud');
    if (!fs.existsSync(cmd[0]) || !fs.existsSync(dec)) {
        this.say('our own player is not installed (' + (!fs.existsSync(cmd[0]) ? cmd[0] : dec) + ')');
        return this.devs;
    }
    const res = await this.alsa(['probe'].concat(this.o.alsaProbeArgs || []), this.o.probeDevMs || 20000);
    this.probe = res;
    const all = (res.devices || []).filter((d) => d && typeof d.name === 'string');
    const free = all.filter((d) => !d.held);
    this.say('the car\'s sound devices named like ours: ' + (res.error ? 'not read: ' + res.error : (free.map((d) => short(d.name)).join(', ') || 'none')) +
        (all.length > free.length ? ' | another program has: ' + all.filter((d) => d.held).map((d) => short(d.name) + ' (' + d.held + ')').join(', ') : ''));
    this.devs = free.map((d) => d.name);
    return this.devs;
};
/* ytalsa.py with these arguments, its one JSON answer (never rejects: { error } instead). */
Sinks.prototype.alsa = function (args, ms) {
    const o = this.o, cmd = o.alsaCmd || ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(__dirname, 'ytalsa.py')];
    return new Promise((resolve) => {
        let so = '', se = '', child, done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
        const why = () => { const l = se.trim().split('\n').pop().trim(); return l ? ': ' + l.slice(0, 200) : ''; };
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } end({ error: 'no answer in ' + Math.round(ms / 1000) + ' s' }); }, ms);
        try { child = cp.spawn(cmd[0], cmd.slice(1).concat(args), { cwd: '/', env: o.alsaEnv || {}, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { end({ error: e.message }); return; }
        child.stdout.on('data', (d) => { if (so.length < (1 << 20)) so += d; });
        child.stderr.on('data', (d) => { se = (se + d).slice(-2000); });
        child.on('error', (e) => end({ error: e.message }));
        child.on('close', (code) => { let v = null; try { v = JSON.parse(so); } catch (e) { v = null; } end(v && typeof v === 'object' ? v : { error: 'it ended (' + code + ') without an answer' + why() }); });
    });
};
/* Our source connected to the loudspeakers by the car's audio manager, asked for by the app (the service asks
 * the car for nothing). Once per play: every device our own player tries needs the same connection. */
Sinks.prototype.amConnect = async function () {
    if (this.am) return { ok: true };
    const r = await this.ask({ op: 'play', plan: 'amconnect' }, this.o.appPlayMs || 20000);
    if (!r.ok) return { ok: false, error: r.msg || 'the app could not get our source connected' };
    this.am = true;
    this.say('our source is connected by the car\'s audio manager');
    return { ok: true };
};
Sinks.prototype.amRelease = async function () {
    if (!this.am) return;
    this.am = false;
    await this.ask({ op: 'release' }, 8000);
};
/* One candidate, from where the picture is now. True once it sounds. */
Sinks.prototype.tryOne = async function (c, gen) {
    const sink = c.make();
    const at = this.where();
    const file = this.want.file;
    try {
        await withTimeout(sink.play(file, at, this.want.info), this.o.soundTryMs || 25000, c.name);
        if (this.cancelled || !this.want || (gen !== undefined && gen !== this.gen)) { await sink.release(); return false; }
        this.attach(sink, at);
        return true;
    } catch (e) {
        this.say('NOT through ' + c.name + ': ' + (e.short || errText(e)));
        try { await sink.release(); } catch (e2) { this.o.log('audio: release: ' + errText(e2)); }
        if (this.state.kept && this.state.kept.key === c.key) { this.state.kept = null; this.save(); }
        return false;
    }
};
/* A player of the car's that says PLAY and then no time would leave the picture standing. So while a sound
 * plays, its time is watched: where none comes for a while, the service counts the clock on itself - the sound
 * keeps playing, the picture keeps moving, and a real time from the player takes over again whenever it comes. */
Sinks.prototype.watchTime = function () {
    if (this.assistT) return;
    const every = this.o.assistEveryMs || 250;
    this.assistT = setInterval(() => {
        const a = this.sound;
        if (!a || this.held || !this.lastTime) return;
        const now = Date.now();
        if (now - this.lastTime.at < (this.o.assistAfterMs || 1800)) return;
        if (this.gateFn && !this.gateFn(this.lastTime.elapsed)) { this.lastTime.at = now; return; }   // the video is not fetched that far
        if (!this.assisted) { this.assisted = true; this.say(a.name + ' gives no time of its own: the service counts the picture on'); }
        const e = this.lastTime.elapsed + (now - this.lastTime.at);
        this.h.time({ elapsed: e, total: this.lastTime.total > 1 ? this.lastTime.total : e + 2000 });
    }, every);
    if (this.assistT.unref) this.assistT.unref();
};
Sinks.prototype.stopWatch = function () {
    if (this.assistT) clearInterval(this.assistT);
    this.assistT = null;
    this.assisted = false;
};
/* The sound goes under the playing picture: from here its clock is the one the daemon follows. */
Sinks.prototype.attach = function (sink, at) {
    this.clockOff();
    this.sound = sink;
    sink.active = true;
    this.held = false;
    this.lastTime = { elapsed: at, total: (this.want && this.want.info && this.want.info.durationMs) || 0, at: Date.now() };
    this.assisted = false;
    this.watchTime();
    this.state.kept = { key: sink.key, at: Date.now(), name: sink.name };
    this.save();
    this.say('PLAYS through ' + sink.name + (at > 1500 ? ' from ' + Math.round(at / 1000) + ' s' : ''));
    this.note('Sound: ' + sink.name);
    this.done('plays through ' + sink.name);
    if (this.out.attached) { try { this.out.attached(sink, at); } catch (e) { this.o.log('audio: attached: ' + errText(e)); } }
};
Sinks.prototype.clockOff = function () {
    if (this.clock) { this.clock.stopTicking(); }
};
Sinks.prototype.where = function () {
    if (this.out.where) { try { return this.out.where(); } catch (e) { /* ours below */ } }
    return this.clock ? this.clock.where() : this.at;
};
Sinks.prototype.done = function (result) {
    const run = { at: this.startedAt || Date.now(), file: this.want ? path.basename(this.want.file) : '?', result: result, lines: this.story.slice() };
    this.runs.unshift(run);
    if (this.runs.length > 3) this.runs.length = 3;
    if (!this.sound) this.note(result === 'plays' ? '' : 'No sound on this car yet - the video plays on (Settings > Diagnostics)');
    this.keepStory(run);
};
Sinks.prototype.keepStory = function (run) {
    if (!this.o.logDir) return;
    const f = path.join(this.o.logDir, 'sound.log');
    try {
        let big = false;
        try { big = fs.statSync(f).size > 400000; } catch (e) { /* not there yet */ }
        const text = new Date(run.at).toISOString() + ' ' + run.file + ' | ' + run.result + '\n' + run.lines.join('\n') + '\n\n';
        if (big) fs.writeFileSync(f, text); else fs.appendFileSync(f, text);
    } catch (e) { /* the page still has it */ }
};

/* ---- what the daemon drives, whichever sink plays ---- */

Sinks.prototype.replay = function (file, ms) {
    if (this.want) this.want.file = file;
    const a = this.active();
    return a ? Promise.resolve(a.replay(file, ms)) : Promise.resolve();
};
Sinks.prototype.button = function (b) {
    this.held = b === 'PAUSE' || b === 'STOP';
    if (!this.held && this.lastTime) this.lastTime.at = Date.now();   // (counted on from here, not from the pause)
    const a = this.active();
    return a ? Promise.resolve(a.button(b)) : Promise.resolve();
};
Sinks.prototype.seek = function (ms) {
    this.at = Math.max(0, Math.floor(ms || 0));
    if (this.lastTime) this.lastTime = { elapsed: this.at, total: this.lastTime.total, at: Date.now() };
    const a = this.active();
    return a ? Promise.resolve(a.seek(ms)).catch((e) => this.o.log('audio: seek: ' + errText(e))) : Promise.resolve();
};
/* Every exit path ends here. Safe to call twice. A search in flight is cancelled, never waited for. */
Sinks.prototype.release = async function () {
    this.cancelled = true;
    this.want = null;
    const s = this.sound, c = this.clock;
    this.stopWatch();
    this.sound = null;
    this.clock = null;
    if (c) c.stopTicking();
    if (s) {
        try { await withTimeout(s.release(), this.o.releaseMs || 8000, 'release'); } catch (e) { this.o.log('audio: release: ' + errText(e)); }
    }
    try { await withTimeout(this.amRelease(), this.o.releaseMs || 8000, 'amRelease'); } catch (e) { this.o.log('audio: release: ' + errText(e)); }
};
Sinks.prototype.cancel = function () { this.cancelled = true; };
/* The sound that played fell away (the daemon saw its player stop in the middle, or it would not go on). It is
 * let go and, twice over in one video, not tried again for that video. */
Sinks.prototype.fellAway = function () {
    const s = this.sound;
    if (!s) return null;
    this.stopWatch();
    this.dropped[s.key] = (this.dropped[s.key] || 0) + 1;
    this.sound = null;
    s.release().catch((e) => this.o.log('audio: release: ' + errText(e)));
    return s;
};
/* The driver hears nothing through what plays: it is left out from now on, and the search goes on under the
 * picture, which never stops. Returns the name left out, or null. */
Sinks.prototype.nosound = function () {
    const s = this.sound;
    if (!s) return null;
    this.stopWatch();
    this.state.silent[s.key] = Date.now();
    if (this.state.kept && this.state.kept.key === s.key) this.state.kept = null;
    this.save();
    this.sound = null;
    s.release().catch((e) => this.o.log('audio: release: ' + errText(e)));
    // the picture goes on: our own clock takes over where the sound was, and the search looks further
    if (this.want) {
        this.clock = new ClockSink(this.o, this.h, (ms) => (this.gateFn ? this.gateFn(ms) : true));
        this.clock.play(this.want.file, this.where(), this.want.info);
        this.cancelled = false;
        this.search();
    }
    return s.name;
};
Sinks.prototype.reset = function () {
    this.state = { v: STATE_V, ver: this.o.version || '?', silent: {}, kept: null };
    this.save();
    this.plansMemo = null;
    this.devs = null;
};
/* The Diagnostics page's lines about the sound. */
Sinks.prototype.lines = function () {
    const out = ['# Sound on this car'];
    const st = this.status();
    out.push('Now: ' + (st.route === 'silent' ? (st.searching ? 'looking for sound' : 'no sound (the picture plays on this service\'s clock)') : st.name));
    const k = this.state.kept;
    out.push('Kept from the last play that sounded: ' + (k ? k.name + ' (' + k.key + ')' : 'none yet'));
    const sil = Object.keys(this.state.silent);
    if (sil.length) out.push('Left out as silent (the driver pressed "No sound?"): ' + sil.join(', '));
    if (this.appReport && this.appReport.length) {
        out.push('# What the app can ask the car for');
        this.appReport.slice(0, 40).forEach((l) => out.push(String(l).slice(0, 300)));
    }
    if (this.probe) {
        out.push('# The car\'s sound devices (read from its files, nothing opened)');
        if (this.probe.error) out.push('not read: ' + String(this.probe.error).slice(0, 200));
        (this.probe.devices || []).slice(0, 24).forEach((d) => out.push(short(d.name) + (d.held ? ' - ' + d.held + ' has it' : ' - free') + (d.sure !== undefined ? ' (likeliness ' + d.sure + ')' : '')));
        (this.probe.notes || []).slice(0, 12).forEach((l) => out.push(String(l).slice(0, 300)));
        (this.probe.map || []).slice(0, 12).forEach((l) => out.push('config: ' + String(l).slice(0, 280)));
    }
    this.runs.forEach((r, i) => {
        out.push('# The ' + (i === 0 ? 'last' : i === 1 ? 'play before it' : 'play before that') + ': ' + r.file + ' - ' + r.result);
        r.lines.slice(0, 60).forEach((l) => out.push(l));
    });
    return out;
};

module.exports = { Sinks, ClockSink, AppSink, OwnPlaySink };
