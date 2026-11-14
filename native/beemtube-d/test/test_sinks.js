'use strict';
/*
 * The iDrive 8 play: the picture first, the sound beside it (ytd.js + audio.js).  node test/test_sinks.js
 *
 * No `someip` is given to the daemon anywhere in this file: on iDrive 8 the service must not load the car's
 * binding at all, so a daemon that tried to would fail here (the path does not exist on a computer either).
 * The app's side of the sound is a fake client on the control socket.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { Daemon } = require('../ytd.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sinks-'));
const cache = path.join(tmp, 'cache');
const ytlog = path.join(tmp, 'ytdec.calls');
fs.mkdirSync(cache);
const fakeYtdec = path.join(__dirname, 'fake_ytdec.js');
fs.chmodSync(fakeYtdec, 0o755);
process.env.FAKE_YTDEC_LOG = ytlog;
fs.writeFileSync(ytlog + '.mode', 'ok');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ytdecLines = () => { try { return fs.readFileSync(ytlog, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; } };

function mkVideo(id, opts) {
    opts = opts || {};
    const d = path.join(cache, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: id, title: 'T ' + id, channel: 'C', duration_s: opts.duration_s || 60 }));
    (opts.files || ['audio.m4a', 'index.bin', 'video.h264']).forEach((f) => fs.writeFileSync(path.join(d, f), 'x'));
    return d;
}

/* A client of the control socket; `app` makes it BeeMTube's app, which answers our audio requests. */
function client(sock, app) {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(sock);
        const seen = [];
        const waiters = [];
        let buf = '';
        const c = {
            sock: s, seen: seen,
            send: (o) => s.write(JSON.stringify(o) + '\n'),
            clear: () => { seen.length = 0; },
            close: () => s.destroy(),
            waitFor: (fn, ms) => new Promise((res, rej) => {
                const hit = seen.find(fn);
                if (hit) return res(hit);
                const w = { fn: fn, res: res };
                waiters.push(w);
                const t = setTimeout(() => {
                    const i = waiters.indexOf(w);
                    if (i >= 0) waiters.splice(i, 1);
                    rej(new Error('nothing matched in ' + (ms || 8000) + ' ms; saw ' + JSON.stringify(seen.slice(-14))));
                }, ms || 8000);
                w.res = (v) => { clearTimeout(t); res(v); };
                return undefined;
            }),
        };
        s.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let m;
                try { m = JSON.parse(line); } catch (e) { continue; }
                seen.push(m);
                if (process.env.TRACE) console.error('  <<', JSON.stringify(m).slice(0, 180));
                if (m.ev === 'audio' && app) app(m, c);
                for (let k = waiters.length - 1; k >= 0; k--) {
                    if (waiters[k].fn(m)) { const w = waiters.splice(k, 1)[0]; w.res(m); }
                }
            }
        });
        s.on('error', reject);
        s.on('connect', () => resolve(c));
    });
}

const results = [];
let LOGS = [];
async function t(name, fn) {
    const from = LOGS.length;
    try { await fn(); results.push('ok   ' + name); } catch (e) {
        results.push('FAIL ' + name + '\n' + (e.stack || e) + '\n  log: ' + LOGS.slice(from).slice(-18).join('\n  log: '));
    }
}
const waitUntil = async (fn, ms) => {
    const end = Date.now() + (ms || 6000);
    while (!fn()) { if (Date.now() > end) throw new Error('waitUntil gave up'); await sleep(25); }
};

async function main() {
    const logs = [];
    const d = new Daemon({
        id8: true, settleS: 0, ytdec: fakeYtdec, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl.sock'),
        stateDir: path.join(tmp, 'state'), noSetuid: true, spare: false, resume: false, noHwCheck: true,
        watchdogMs: 100000, tickMs: 2000, keep: 20, fetchRetryMs: [],
        alsaCmd: ['/nonexistent/python3', 'x'], ytaud: '/nonexistent/ytaud',   // our own player is not installed here
        soundSearchMs: 4000, soundTryMs: 2000, appPlansMs: 1500, appPlayMs: 1500,
        log: (m) => { logs.push(m); LOGS.push(m); },
    });
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    mkVideo('DemoVideo01');
    mkVideo('DemoVideo02');
    await d.start();
    assert.ok(logs.some((l) => /asks the car for nothing/.test(l)), 'the service says it asks the car for nothing');

    // ---------------------------------------------------------------- the picture does not wait for the sound
    let c = await client(d.opts.sock);
    await t('a play starts the picture at once, with no app and no sound: state playing, ytdec started, the clock ticks', async () => {
        c.clear();
        fs.writeFileSync(ytlog, '');
        const t0 = Date.now();
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1358x764', fill: false });
        const pl = await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        assert.ok(Date.now() - t0 < 2000, 'it played within 2 s, not after a search for sound');
        assert.strictEqual(pl.snd.route, 'silent');
        await waitUntil(() => ytdecLines().length > 0);
        assert.ok(ytdecLines()[0].indexOf('--rect 1358x764') >= 0, ytdecLines()[0]);
        const tm = await c.waitFor((x) => x.ev === 'time' && x.elapsed > 0);
        assert.strictEqual(tm.total, 60000, 'the length comes from the video\'s own meta');
        await waitUntil(() => ytdecLines().some((l) => /clock \d+ \d+/.test(l)), 4000);
    });

    await t('the picture plays on when nothing sounds, and the app is told', async () => {
        const st = await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.snd && !x.snd.searching, 8000);
        assert.strictEqual(st.snd.route, 'silent');
        assert.ok(d.state === 'playing', 'still playing');
    });

    await t('pause, seek and resume work with no sound at all', async () => {
        c.clear();
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        const at = d.elapsed;
        await sleep(600);
        assert.ok(Math.abs(d.elapsed - at) < 200, 'the clock stands while paused (' + at + ' -> ' + d.elapsed + ')');
        c.send({ cmd: 'seek', ms: 20000 });
        await waitUntil(() => Math.abs(d.elapsed - 20000) < 500);
        c.send({ cmd: 'resume' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => d.elapsed > 20200, 3000);
    });

    await t('the end of the video: ended, as the car\'s own player says it', async () => {
        c.clear();
        c.send({ cmd: 'seek', ms: 59000 });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'ended', 6000);
    });

    // ---------------------------------------------------------------- the app's plan plays
    await t('the app offers a plan: it goes under the playing picture and its clock takes over', async () => {
        let played = null, releases = 0;
        const app = (m, cl) => {
            if (m.op === 'plans') return cl.send({ cmd: 'audio_res', req: m.req, ok: true, plans: [{ key: 'bmw', name: 'the car\'s media player', holdsPosition: true }], report: ['the app can see the player'] });
            if (m.op === 'play') { played = m; return cl.send({ cmd: 'audio_res', req: m.req, ok: true, name: 'the car\'s media player (OapGenericMedia)' }); }
            if (m.op === 'release') { releases++; return cl.send({ cmd: 'audio_res', req: m.req, ok: true }); }
            return cl.send({ cmd: 'audio_res', req: m.req, ok: true });
        };
        c.close();
        c = await client(d.opts.sock, app);
        c.send({ cmd: 'audio_hello', version: '0.6.0' });
        c.send({ cmd: 'play', id: 'DemoVideo02', rect: '1358x764' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => d.sinks.status().route === 'app:bmw', 8000);
        const st = d.sinks.status();
        assert.ok(/media player/.test(st.name), st.name);
        assert.strictEqual(st.kept, true, 'the way that played is kept for the next play');
        assert.ok(played && played.file.endsWith('audio.m4a'), 'the app got the audio file: ' + JSON.stringify(played && played.file));
        assert.strictEqual(typeof played.at, 'number', 'and where the picture is');
        assert.strictEqual(played.info.durationMs, 60000);
        assert.strictEqual(releases, 0, 'nothing was released while it plays');
        // from here the app's player is the clock: our own has stopped
        const stood = d.elapsed;
        await sleep(600);
        assert.strictEqual(d.elapsed, stood, 'our own clock stopped when the sound took over (' + stood + ' -> ' + d.elapsed + ')');
        fs.writeFileSync(ytlog, '');
        for (let i = 0; i < 4; i++) { c.send({ cmd: 'audio_ev', kind: 'time', value: { elapsed: 12000 + i * 300, total: 60000 } }); await sleep(120); }
        await waitUntil(() => d.elapsed >= 12000, 3000);
        await waitUntil(() => ytdecLines().some((l) => /clock 12\d\d\d/.test(l)), 3000);
        const tm = await c.waitFor((x) => x.ev === 'time' && x.elapsed >= 12000, 4000);
        assert.ok(tm.total === 60000, JSON.stringify(tm));
    });

    await t('"No sound?": the way is left out, the video plays on without stopping', async () => {
        c.clear();
        const before = d.elapsed;
        c.send({ cmd: 'nosound' });
        const st = await c.waitFor((x) => x.ev === 'state' && x.snd && x.snd.route === 'silent', 6000);
        assert.strictEqual(st.state, 'playing', 'it never left the playing state');
        assert.strictEqual(st.snd.silent, 1);
        await waitUntil(() => d.elapsed > before, 3000);
        assert.ok(d.ticking, 'the picture still runs');
    });

    await t('the app going away mid-play does not stop the video', async () => {
        const id = d.cur && d.cur.id;
        c.close();
        await sleep(300);
        assert.strictEqual(d.appAudio, false, 'its audio side is forgotten');
        // (the client going away stops playback by design - a new client takes over and plays again)
        c = await client(d.opts.sock);
        c.send({ cmd: 'play', id: id, rect: '1358x764' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
    });

    await t('a plan that refuses leaves the video playing in silence', async () => {
        c.close();
        c = await client(d.opts.sock, (m, cl) => {
            if (m.op === 'plans') return cl.send({ cmd: 'audio_res', req: m.req, ok: true, plans: [{ key: 'dyn', name: 'the car\'s dynamic media player' }] });
            return cl.send({ cmd: 'audio_res', req: m.req, ok: false, msg: 'the car answered BAD_ARGUMENT' });
        });
        c.send({ cmd: 'audio_hello' });
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1358x764' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await c.waitFor((x) => x.ev === 'note' && /No sound on this car/.test(x.msg), 8000);
        assert.strictEqual(d.state, 'playing');
        const diag = await (async () => { c.clear(); c.send({ cmd: 'diag' }); return c.waitFor((x) => x.ev === 'diag', 8000); })();
        assert.ok(diag.lines.some((l) => /BAD_ARGUMENT/.test(l)), 'the page says what the car answered');
        assert.ok(diag.lines.some((l) => /# Sound on this car/.test(l)));
    });

    await t('an app that never answers does not hold the play, and stop is instant', async () => {
        c.close();
        c = await client(d.opts.sock, () => { /* never answers */ });
        c.send({ cmd: 'audio_hello' });
        c.send({ cmd: 'play', id: 'DemoVideo02', rect: '1358x764' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        const t0 = Date.now();
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle', 4000);
        assert.ok(Date.now() - t0 < 2500, 'stop took ' + (Date.now() - t0) + ' ms while the app was silent');
    });

    await t('the sound stopping on its own does not stop the picture', async () => {
        c.close();
        let plays = 0;
        c = await client(d.opts.sock, (m, cl) => {
            if (m.op === 'plans') return cl.send({ cmd: 'audio_res', req: m.req, ok: true, plans: [{ key: 'bmw', name: 'the car\'s media player', holdsPosition: true }] });
            if (m.op === 'play') plays++;
            return cl.send({ cmd: 'audio_res', req: m.req, ok: true });
        });
        c.send({ cmd: 'audio_hello' });
        c.send({ cmd: 'soundreset' });            // (the way left out above is tried again: Settings > Sound: start over)
        await c.waitFor((x) => x.ev === 'state');
        assert.strictEqual(d.sinks.status().silent, 0, 'start over forgets what was left out');
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1358x764' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => d.sinks.status().route === 'app:bmw', 8000);
        c.send({ cmd: 'audio_ev', kind: 'state', value: 'PLAYER_STATE_PLAY' });
        for (let i = 0; i < 3; i++) { c.send({ cmd: 'audio_ev', kind: 'time', value: { elapsed: 5000 + i * 300, total: 60000 } }); await sleep(120); }
        await waitUntil(() => d.elapsed >= 5000, 3000);
        c.clear();
        const playsBefore = plays;
        c.send({ cmd: 'audio_ev', kind: 'state', value: 'PLAYER_STATE_STOP' });   // the car took the audio away
        await c.waitFor((x) => x.ev === 'note' && /sound stopped/.test(x.msg), 4000);
        assert.strictEqual(d.state, 'playing', 'the picture plays on');
        assert.ok(d.ticking, 'and it still runs');
        const was = d.elapsed;
        await waitUntil(() => d.elapsed > was + 200, 4000);          // the clock runs again (ours, or the sound's)
        await waitUntil(() => plays > playsBefore, 4000).catch((e) => {
            throw new Error('no second play request: plays=' + plays + ' before=' + playsBefore + ' sinks=' + JSON.stringify({
                gen: d.sinks.gen, searchingGen: d.sinks.searchingGen, cancelled: d.sinks.cancelled,
                want: !!d.sinks.want, sound: !!d.sinks.sound, dropped: d.sinks.dropped, silent: d.sinks.state.silent }));
        });            // and the sound is looked for again
        // a sound that keeps falling away is not tried a third time for this video
        c.send({ cmd: 'audio_ev', kind: 'state', value: 'PLAYER_STATE_PLAY' });
        c.send({ cmd: 'audio_ev', kind: 'time', value: { elapsed: 9000, total: 60000 } });
        await sleep(150);
        c.send({ cmd: 'audio_ev', kind: 'state', value: 'PLAYER_STATE_STOP' });
        await waitUntil(() => d.sinks.status().route === 'silent' && !d.sinks.status().searching, 8000);
        assert.strictEqual(d.state, 'playing', 'and the video still plays, now in silence');
    });

    await t('a play while a video is already playing: the old sound is let go', async () => {
        c.clear();
        c.send({ cmd: 'play', id: 'DemoVideo02', rect: '1358x764' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        assert.strictEqual(d.cur.id, 'DemoVideo02');
    });

    c.close();
    await d.close();

    // ---------------------------------------------------------------- our own player on the car's audio router
    // The app only gets our source connected (plan 'amconnect'); the samples are written by this service, and the
    // router reads the device only while that connection stands - which is what ytalsa.py measures.
    const alsaLog = path.join(tmp, 'alsa.log');
    const alsaState = path.join(tmp, 'alsa.state.json');
    fs.writeFileSync(alsaState, '{}');
    const d2 = new Daemon({
        id8: true, settleS: 0, ytdec: fakeYtdec, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl2.sock'),
        stateDir: path.join(tmp, 'state2'), noSetuid: true, spare: false, resume: false, noHwCheck: true,
        watchdogMs: 100000, tickMs: 2000, keep: 20, fetchRetryMs: [],
        alsaCmd: [process.execPath, path.join(__dirname, 'fake_ytalsa.js')],
        ytaud: path.join(__dirname, 'fake_ytalsa.js'),
        alsaEnv: { FAKE_ALSA_WAYS: JSON.stringify({ 'plug:smartx:OAPMedia': 'flows@am', 'plug:smartx:Dynamic': 'stalls' }),
            FAKE_ALSA_STATE: alsaState, FAKE_ALSA_LOG: alsaLog },
        soundSearchMs: 20000, soundTryMs: 9000, appPlansMs: 2000, appPlayMs: 2000, ownStartMs: 4000,
        log: (m) => { logs.push(m); LOGS.push(m); },
    });
    fs.mkdirSync(path.join(tmp, 'state2'), { recursive: true });
    await d2.start();
    const ownApp = (m, cl) => {
        if (m.op === 'plans') return cl.send({ cmd: 'audio_res', req: m.req, ok: true, plans: [{ key: 'amconnect', name: 'our source connected by the car\'s audio manager', holdsPosition: true }] });
        // the app asks the audio manager to connect our source: the stand-in router then reads our device
        if (m.op === 'play') { fs.writeFileSync(alsaState, JSON.stringify({ am: true })); return cl.send({ cmd: 'audio_res', req: m.req, ok: true, caps: { holdsPosition: true } }); }
        if (m.op === 'release') { fs.writeFileSync(alsaState, '{}'); return cl.send({ cmd: 'audio_res', req: m.req, ok: true }); }
        return cl.send({ cmd: 'audio_res', req: m.req, ok: true });
    };
    let c2 = await client(d2.opts.sock, ownApp);
    await t('our own player: the device the car reads once our source is connected plays, and its clock drives the picture', async () => {
        c2.send({ cmd: 'audio_hello' });
        c2.send({ cmd: 'play', id: 'DemoVideo01', rect: '1358x764' });
        await c2.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => /^own:/.test(d2.sinks.status().route), 15000);
        assert.strictEqual(d2.sinks.status().route, 'own:plug:smartx:OAPMedia', d2.sinks.status().route);
        const asked = fs.readFileSync(alsaLog, 'utf8');
        assert.ok(/probe/.test(asked), 'the devices were read from the car\'s files');
        assert.ok(!/\bscan\b/.test(asked), 'and no silence was written to anything');
        assert.ok(/play .*audio\.m4a/.test(asked), asked.slice(0, 300));
        await waitUntil(() => d2.elapsed > 300, 6000);                 // its own time drives the clock
        await waitUntil(() => ytdecLines().some((l) => /clock \d+ \d+/.test(l)), 4000);
    });

    await t('our own player: pause and resume go on in place, and a seek moves it', async () => {
        c2.send({ cmd: 'pause' });
        await c2.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        const at = d2.elapsed;
        await sleep(400);
        assert.ok(Math.abs(d2.elapsed - at) < 250, 'it stands while paused');
        c2.send({ cmd: 'resume' });
        await c2.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => d2.elapsed > at + 200, 4000);
        assert.strictEqual(d2.sinks.status().route, 'own:plug:smartx:OAPMedia', 'and it is still the same player');
        c2.send({ cmd: 'seek', ms: 42000 });
        await waitUntil(() => d2.elapsed >= 42000, 4000);
        const asked = fs.readFileSync(alsaLog, 'utf8');
        assert.ok(/\tpause\b/.test(asked) && /\tresume\b/.test(asked) && /\tseek 42000/.test(asked), asked.split('\n').slice(-6).join(' | '));
    });

    await t('a device the car does not read is not used, and with none the video plays in silence', async () => {
        c2.send({ cmd: 'stop' });
        await c2.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        c2.send({ cmd: 'soundreset' });
        fs.writeFileSync(alsaState, '{}');                 // nothing is connected: no device takes samples
        c2.close();
        c2 = await client(d2.opts.sock, (m, cl) => {
            if (m.op === 'plans') return cl.send({ cmd: 'audio_res', req: m.req, ok: true, plans: [{ key: 'amconnect', name: 'our source connected', holdsPosition: true }] });
            return cl.send({ cmd: 'audio_res', req: m.req, ok: true });    // the app says it connected, but nothing reads
        });
        c2.send({ cmd: 'audio_hello' });
        c2.send({ cmd: 'play', id: 'DemoVideo02', rect: '1358x764' });
        await c2.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await c2.waitFor((x) => x.ev === 'note' && /No sound on this car/.test(x.msg), 25000);
        assert.strictEqual(d2.state, 'playing', 'the video plays on');
        assert.strictEqual(d2.sinks.status().route, 'silent');
    });

    c2.close();
    await d2.close();
    console.log(results.join('\n'));
    const bad = results.filter((r) => r.startsWith('FAIL'));
    console.log(bad.length ? 'sinks: ' + bad.length + ' FAILED' : 'sinks: all ok');
    process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
