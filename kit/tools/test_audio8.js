'use strict';
/*
 * The app's side of the car's sound (apps/wali_beemtube/audio8.js), against a made-up iDrive 8.
 *   node kit/tools/test_audio8.js
 *
 * audio8.js runs inside the app on the car, where the SDK is given to it as ./kit/sdk and the app manager has
 * written the interface descriptions into the app's own someipInterfaces/. Both are made here, in a copy of the
 * car's layout, so the real file is the one under test.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio8-'));
const home = path.join(tmp, 'oap_1');
const appdir = path.join(home, 'source', 'app');
fs.mkdirSync(appdir, { recursive: true });
fs.mkdirSync(path.join(home, 'someipInterfaces'));
fs.mkdirSync(path.join(appdir, 'kit'));
fs.copyFileSync(path.join(ROOT, 'apps', 'wali_beemtube', 'audio8.js'), path.join(appdir, 'audio8.js'));

const CC = 'org.genivi.am.commandinterface.CommandControl';
const MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const DYN = 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer';
const file = (iface) => path.join(home, 'someipInterfaces', iface.replace(/\./g, '_') + '.json');
function describe(iface, cfg) { fs.writeFileSync(file(iface), JSON.stringify(cfg)); }
function forget(iface) { try { fs.unlinkSync(file(iface)); } catch (e) { /* none */ } }

// the three descriptions this head unit has for our app, as the app manager writes them
describe(CC, { name: 'cc', serviceId: 0xb001, instances: { 1: 1 }, methods: { connect: {}, disconnect: {} } });
describe(MP, { name: 'mp', serviceId: 0xb042, instances: { OapGenericMedia: 0x28, Usb: 2 },
    methods: { playFile: {}, sendButtonEvent: {}, setTime: {} }, fields: { playerState: {}, currentItemTime: {} } });
describe(DYN, { name: 'dyn', serviceId: 0xb0c0,
    instances: { DynamicMediaPlayerMedia: 1, DynamicMediaPlayerTempMedia: 2, DynamicMediaPlayerTempLumMedia: 3, DynamicMediaPlayerBrowser: 4 },
    methods: {
        // what the car declares getAudioFocus takes: this is what the arguments are built from
        getAudioFocus: { schema: { t: 'Struct', e: [{ n: 'clientId', t: 'UInt32' }, { n: 'clientName', t: 'Utf16D' }, { n: 'timeOutHeartBeatTimer', t: 'UInt32' }] } },
        createPlaylist: {}, sendButtonEventDirect: {}, heartBeat: {}, releaseAudioFocus: {}, setCurrentItemPositionAndTime: {},
    },
    fields: { playerState: {}, currentItemTime: {}, connectionState: {}, currentAudioFocus: {} } });

/* ---- the car: a typed proxy per instance, with whatever behaviour a test wants ---- */
let car;
function freshCar(over) {
    car = Object.assign({
        calls: [],
        offers: { 'org.genivi.am.commandinterface.CommandControl|1': true },
        connect: () => ({ mainConnectionID: 42, amError: 'E_OK' }),
        playFile: () => ({ EntError: 'OK' }),
        // the car answered BAD_ARGUMENT to every string id; a number of the right type is taken
        getAudioFocus: (a) => (typeof a.clientId === 'number' && typeof a.timeOutHeartBeatTimer === 'number'
            ? { token: 'TOK', dynMediaPlayerError: 'OK' } : { dynMediaPlayerError: 'BAD_ARGUMENT' }),
        createPlaylist: () => { car.list = true; return { dynMediaPlayerError: 'OK' }; },
        // what makes this car play once it has our playlist: nothing ('auto'), the position call, or PLAY
        startsOn: 'pos',
        setCurrentItemPositionAndTime: () => { if (car.list && car.startsOn === 'pos') car.playerState = 'PLAYER_STATE_PLAY'; return { dynMediaPlayerError: 'OK' }; },
        sendButtonEventDirect: (a) => { if (car.list && car.startsOn === 'play' && a.button === 'PLAY') car.playerState = 'PLAYER_STATE_PLAY'; return { dynMediaPlayerError: 'OK' }; },
        playerState: 'PLAYER_STATE_STOP',
        slow: {},         // method -> ms it takes
        throws: {},       // method -> the error it throws
        shape: 'member',  // 'member': p.m(args) | 'callMethod': p.callMethod(m, args, ms)
        subs: {},
    }, over || {});
    MP_INSTANCES.length = 0;
    return car;
}
const MP_INSTANCES = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeProxy(iface, inst) {
    const key = iface + '|' + inst;
    if (car.offers[key] === false) return Promise.reject(new Error('not offered'));
    if (car.offers[key] === 'never') return new Promise(() => {});       // never answers
    const run = async (m, args) => {
        car.calls.push({ iface: iface, inst: inst, m: m, args: args });
        if (car.throws[m]) throw new Error(car.throws[m]);
        if (car.slow[m]) await sleep(car.slow[m]);
        const fn = car[m];
        return typeof fn === 'function' ? fn(args || {}, inst) : { };
    };
    const field = (name) => ({
        getValue: () => Promise.resolve(name === 'playerState' ? car.playerState : car[name]),
        subscribe: (fn) => { (car.subs[name] = car.subs[name] || []).push(fn); return Promise.resolve(); },
    });
    const p = { iface: iface, inst: inst, isAvailable: () => Promise.resolve(car.offers[key] !== false) };
    ['playerState', 'currentItemTime', 'connectionState', 'currentAudioFocus', 'playbackErrorEvent'].forEach((n) => { p[n] = field(n); });
    if (car.shape === 'member') {
        ['connect', 'disconnect', 'playFile', 'sendButtonEvent', 'setTime', 'getAudioFocus', 'createPlaylist',
            'sendButtonEventDirect', 'heartBeat', 'releaseAudioFocus', 'setCurrentItemPositionAndTime'].forEach((m) => { p[m] = (args) => run(m, args); });
        p.setAutoplay = (args) => run('setAutoplay', args);
    } else {
        p.callMethod = (m, args) => run(m, args);
    }
    if (iface === MP) MP_INSTANCES.push(inst);
    return Promise.resolve(p);
}
function installSdk() {
    fs.writeFileSync(path.join(appdir, 'kit', 'sdk.js'), 'module.exports = global.__FAKE_SDK__;\n');
}
installSdk();
global.__FAKE_SDK__ = {
    OnlineApp: function () {}, logging: {},
    someipBuilders: { buildAndInitTypedProxy: (iface, inst) => makeProxy(iface, inst) },
};

function load() {
    const p = path.join(appdir, 'audio8.js');
    delete require.cache[require.resolve(p)];
    delete require.cache[require.resolve(path.join(appdir, 'kit', 'sdk.js'))];
    return require(p);
}
const sent = [];
function mk(over) {
    sent.length = 0;
    const { CarAudio } = load();
    return new CarAudio(Object.assign({
        send: (o) => { sent.push(o); return true; },
        log: { info() {}, warn() {}, error() {} },
        appId: 'wali_beemtube8', title: 'BeeMTube', proxyMs: 400, callMs: 400, heartbeatMs: 10000,
    }, over || {}));
}
const ask = (c, o) => { const req = 'r' + Math.random().toString(36).slice(2, 7); return c.onRequest(Object.assign({ req: req, ev: 'audio' }, o)).then(() => sent.filter((x) => x.cmd === 'audio_res' && x.req === req)[0]); };

const results = [];
async function t(name, fn) {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + '\n' + (e.stack || e)); }
}

async function main() {
    await t('plans: the car\'s media player, each entertainment instance of its dynamic player, and the audio manager', async () => {
        freshCar();
        const c = mk();
        const r = await ask(c, { op: 'plans' });
        assert.ok(r.ok, JSON.stringify(r));
        assert.deepStrictEqual(r.plans.map((p) => p.key),
            ['bmw', 'dyn:DynamicMediaPlayerMedia', 'dyn:DynamicMediaPlayerTempMedia', 'dyn:DynamicMediaPlayerTempLumMedia', 'amconnect'],
            'the browser instance of the dynamic player is not one of ours');
        assert.ok(r.report.some((l) => /media player "OapGenericMedia" answers this app/.test(l)), r.report.join(' | '));
    });

    await t('a car that describes nothing: no plan, and it says so instead of failing', async () => {
        freshCar();
        [CC, MP, DYN].forEach(forget);
        const c = mk();
        const r = await ask(c, { op: 'plans' });
        assert.ok(r.ok);
        assert.deepStrictEqual(r.plans, []);
        assert.ok(r.report.some((l) => /no description for this app/.test(l)), r.report.join(' | '));
        describe(CC, { name: 'cc', serviceId: 0xb001, instances: { 1: 1 } });
        describe(MP, { name: 'mp', serviceId: 0xb042, instances: { OapGenericMedia: 0x28 } });
        describe(DYN, { name: 'dyn', serviceId: 0xb0c0, instances: { DynamicMediaPlayerMedia: 1 },
            methods: { getAudioFocus: { schema: { t: 'Struct', e: [{ n: 'clientId', t: 'UInt32' }, { n: 'clientName', t: 'Utf16D' }, { n: 'timeOutHeartBeatTimer', t: 'UInt32' }] } } } });
    });

    await t('the car\'s media player: our source connected, then the file, and its words reach the service', async () => {
        freshCar();
        const c = mk();
        await ask(c, { op: 'plans' });
        const r = await ask(c, { op: 'play', plan: 'bmw', file: '/cache/x/audio.m4a', at: 0, info: { durationMs: 60000, id: 'abc' } });
        assert.ok(r.ok, JSON.stringify(r));
        const cc = car.calls.filter((x) => x.m === 'connect')[0];
        assert.deepStrictEqual(cc.args, { sourceID: 1046, sinkID: 1024 });
        const pf = car.calls.filter((x) => x.m === 'playFile')[0];
        assert.deepStrictEqual(pf.args, { path: '/cache/x/audio.m4a', languageCode: 7695972 });
        assert.strictEqual(pf.inst, 'OapGenericMedia');
        // the player's own state and time, as the service expects them
        car.subs.playerState.forEach((f) => f('PLAYER_STATE_PLAY'));
        car.subs.currentItemTime.forEach((f) => f({ elapsed: 4200, total: 60000 }));
        const st = sent.filter((x) => x.cmd === 'audio_ev' && x.kind === 'state').pop();
        const tm = sent.filter((x) => x.cmd === 'audio_ev' && x.kind === 'time').pop();
        assert.strictEqual(st.value, 'PLAYER_STATE_PLAY');
        assert.deepStrictEqual(tm.value, { elapsed: 4200, total: 60000 });
        // and everything is given back
        await ask(c, { op: 'release' });
        assert.ok(car.calls.some((x) => x.m === 'sendButtonEvent' && x.args.button === 'STOP'));
        assert.ok(car.calls.some((x) => x.m === 'disconnect' && x.args.mainConnectionID === 42));
    });

    await t('the dynamic player: the focus is asked with the types the car declares, not with guesses', async () => {
        freshCar();
        const c = mk();
        await ask(c, { op: 'plans' });
        const r = await ask(c, { op: 'play', plan: 'dyn:DynamicMediaPlayerMedia', file: '/cache/x/audio.m4a', at: 0, info: { id: 'abc' } });
        const asks = car.calls.filter((x) => x.m === 'getAudioFocus');
        assert.ok(asks.length >= 1 && asks.length <= 24, 'it asked ' + asks.length + ' times, not hundreds');
        assert.ok(asks.every((a) => typeof a.args.clientId === 'number' && typeof a.args.timeOutHeartBeatTimer === 'number'),
            'every clientId was a number, as the description says: ' + JSON.stringify(asks.map((a) => a.args)));
        assert.ok(asks.every((a) => typeof a.args.clientName === 'string'));
        assert.ok(r.ok, JSON.stringify(r));
        const pl = car.calls.filter((x) => x.m === 'createPlaylist')[0];
        assert.strictEqual(pl.args.token, 'TOK');
        assert.strictEqual(pl.args.newPlaylist[0].metadata[0].key, 'FILE_NAME');
        assert.ok(car.calls.some((x) => x.m === 'setCurrentItemPositionAndTime'), 'it was started');
        await ask(c, { op: 'release' });
        assert.ok(car.calls.some((x) => x.m === 'releaseAudioFocus' && x.args.token === 'TOK'), 'the focus is given back');
    });

    await t('a car that refuses the focus whatever it is asked: a refusal with the car\'s own word, no throw', async () => {
        freshCar({ getAudioFocus: () => ({ dynMediaPlayerError: 'BAD_ARGUMENT' }) });
        const c = mk();
        await ask(c, { op: 'plans' });
        const r = await ask(c, { op: 'play', plan: 'dyn:DynamicMediaPlayerMedia', file: '/x.m4a', at: 0 });
        assert.strictEqual(r.ok, false);
        assert.ok(/BAD_ARGUMENT/.test(r.msg), r.msg);
    });

    await t('a player that takes our file and never plays it: said, and nothing is left behind', async () => {
        freshCar({ startsOn: null });
        const c = mk();
        await ask(c, { op: 'plans' });
        const r = await ask(c, { op: 'play', plan: 'dyn:DynamicMediaPlayerMedia', file: '/x.m4a', at: 0 });
        assert.strictEqual(r.ok, false);
        assert.ok(/did not play it/.test(r.msg), r.msg);
        assert.ok(car.calls.some((x) => x.m === 'releaseAudioFocus'), 'the focus is given back');
    });

    await t('a call that throws, and one that never answers: both become refusals', async () => {
        freshCar({ throws: { playFile: 'the binding blew up' } });
        let c = mk();
        await ask(c, { op: 'plans' });
        let r = await ask(c, { op: 'play', plan: 'bmw', file: '/x.m4a', at: 0 });
        assert.strictEqual(r.ok, false);
        assert.ok(/blew up/.test(r.msg), r.msg);
        freshCar({ slow: { playFile: 4000 } });
        c = mk({ callMs: 300 });
        await ask(c, { op: 'plans' });
        const t0 = Date.now();
        r = await ask(c, { op: 'play', plan: 'bmw', file: '/x.m4a', at: 0 });
        assert.strictEqual(r.ok, false);
        assert.ok(Date.now() - t0 < 3500, 'it gave up after ' + (Date.now() - t0) + ' ms');
    });

    await t('a proxy that never comes: the plan is simply not offered', async () => {
        freshCar();
        car.offers[MP + '|OapGenericMedia'] = 'never';
        const c = mk({ proxyMs: 200 });
        const r = await ask(c, { op: 'plans' });
        assert.ok(r.ok);
        assert.ok(r.plans.every((p) => p.key !== 'bmw'), JSON.stringify(r.plans.map((p) => p.key)));
    });

    await t('a proxy of the other shape (p.callMethod): the first way that answers is used and kept', async () => {
        freshCar({ shape: 'callMethod' });
        const c = mk();
        await ask(c, { op: 'plans' });
        const r = await ask(c, { op: 'play', plan: 'bmw', file: '/x.m4a', at: 0 });
        assert.ok(r.ok, JSON.stringify(r));
        assert.ok(c.report.some((l) => /are called as p.callMethod/.test(l)), c.report.join(' | '));
    });

    await t('only the audio manager\'s connection (for the service\'s own player)', async () => {
        freshCar();
        const c = mk();
        await ask(c, { op: 'plans' });
        const r = await ask(c, { op: 'play', plan: 'amconnect', file: '/x.m4a', at: 0 });
        assert.ok(r.ok, JSON.stringify(r));
        assert.ok(r.caps.holdsPosition, 'our own player keeps its place');
        assert.ok(car.calls.some((x) => x.m === 'connect'));
        assert.ok(!car.calls.some((x) => x.m === 'playFile'), 'nothing of the car plays the file');
        await ask(c, { op: 'release' });
        assert.ok(car.calls.some((x) => x.m === 'disconnect'));
    });

    await t('pause, resume and a seek go to whatever plays', async () => {
        freshCar();
        const c = mk();
        await ask(c, { op: 'plans' });
        await ask(c, { op: 'play', plan: 'bmw', file: '/x.m4a', at: 0 });
        await ask(c, { op: 'button', button: 'PAUSE' });
        await ask(c, { op: 'seek', at: 30000 });
        assert.ok(car.calls.some((x) => x.m === 'sendButtonEvent' && x.args.button === 'PAUSE'));
        assert.ok(car.calls.some((x) => x.m === 'setTime' && x.args.newTimeElapsed === 30000));
    });

    await t('a player whose time comes in seconds: told by the video\'s length, and sent on as milliseconds', async () => {
        freshCar();
        const c = mk();
        await ask(c, { op: 'plans' });
        await ask(c, { op: 'play', plan: 'bmw', file: '/x.m4a', at: 0, info: { durationMs: 213000, id: 'abc' } });
        car.subs.currentItemTime.forEach((f) => f({ elapsed: 42, total: 213 }));      // seconds
        let tm = sent.filter((x) => x.cmd === 'audio_ev' && x.kind === 'time').pop();
        assert.deepStrictEqual(tm.value, { elapsed: 42000, total: 213000 }, JSON.stringify(tm.value));
        assert.ok(c.report.some((l) => /time comes in seconds/.test(l)), c.report.join(' | '));
        // a player that counts in milliseconds is left as it is
        freshCar();
        const c2 = mk();
        await ask(c2, { op: 'plans' });
        await ask(c2, { op: 'play', plan: 'bmw', file: '/x.m4a', at: 0, info: { durationMs: 213000, id: 'abc' } });
        car.subs.currentItemTime.forEach((f) => f({ elapsed: 42000, total: 213000 }));
        tm = sent.filter((x) => x.cmd === 'audio_ev' && x.kind === 'time').pop();
        assert.deepStrictEqual(tm.value, { elapsed: 42000, total: 213000 });
    });

    await t('what the car offers is asked again after a while (a player may come up as the head unit finishes starting)', async () => {
        freshCar();
        car.offers[MP + '|OapGenericMedia'] = false;
        const c = mk({ proxyMs: 300, plansKeepMs: 1 });
        let r = await ask(c, { op: 'plans' });
        assert.ok(r.plans.every((p) => p.key !== 'bmw'), 'not offered yet');
        car.offers[MP + '|OapGenericMedia'] = true;
        await sleep(20);
        r = await ask(c, { op: 'plans' });
        assert.ok(r.plans.some((p) => p.key === 'bmw'), 'and found once it is: ' + JSON.stringify(r.plans.map((p) => p.key)));
    });

    await t('an unknown request is refused, and a play without a file too', async () => {
        freshCar();
        const c = mk();
        const r1 = await ask(c, { op: 'fly' });
        assert.strictEqual(r1.ok, false);
        const r2 = await ask(c, { op: 'play', plan: 'bmw' });
        assert.strictEqual(r2.ok, false);
    });

    console.log(results.join('\n'));
    const bad = results.filter((r) => r.startsWith('FAIL'));
    console.log(bad.length ? 'audio8: ' + bad.length + ' FAILED' : 'audio8: all ok');
    process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
