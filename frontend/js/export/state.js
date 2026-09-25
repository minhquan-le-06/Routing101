// frontend/js/export/state.js -- the Export tab's state shape and the small
// pure helpers every export/*.js module shares. One `s` object per
// buildExportUI() call (see ui.js), created by freshState() below.

import { getExportFrame } from "../core/api.js";
import { tile } from "../core/settings.js";

// Initial count and "Show N more" step per preview section -- three rows of
// whatever the tile-size setting makes .export-preview-grid wide (settings.js's
// TILE_SIZES.previewPage/previewColumns), read fresh rather than captured at
// import so a size change in the search tab reaches this one (see settings.js's
// storage listener).
export const previewPage = () => tile().previewPage;

export function freshState(trigger) {
    const isFlat = trigger.kind === "flat";
    const seed = isFlat ? { video_id: trigger.video_id, n: trigger.n } : null;

    return {
        trigger,
        queryType: isFlat ? "KIS" : "TRAKE", // "trake"/"frame" triggers default to TRAKE -- "frame" has no n for KIS/VQA's flat CSV path
        name: "",
        confirmed: true,
        // Export tab's "Keyframes" checkbox (KIS/VQA only): checked (old
        // behavior, unchanged) means the answer is an indexed keyframe n,
        // same as everything below. Unchecked means it's a raw native
        // frame_idx instead, curated via the `native` video-playback panel
        // below rather than the Neighbours/Similars grids -- see the
        // "KIS/VQA native (Keyframes-unchecked) curation" section further
        // down. Defaults unchecked only for a "frame" trigger (opened from
        // video playback, item 7), which has no keyframe n to check it
        // *to* in the first place; togglable regardless, snapping to the
        // nearest keyframe on re-check (getExportNearestKeyframe).
        keyframes: trigger.kind !== "frame",
        answerText: "",
        answerFrame: seed,          // confirmed-mode single answer (KIS/VQA, keyframe n space)
        answers: seed ? [seed] : [], // unconfirmed-mode ordered list, pre-seeded per spec ("at least 1 frame")
        frameInfo: new Map(),        // "vid|n" -> {frame_idx, thumbnail_url} | "pending"
        neighbourFrames: null,       // cached /api/export/neighbors result (grows with `neighboursShown`)
        neighboursShown: previewPage(),
        similarFrames: null,         // confirmed mode: cached /api/export/similar result, keyed to similarFramesKey below
        similarFramesKey: null,      // frameKey(answerFrame) similarFrames was fetched for -- refetch when the confirmed frame changes
        similarsShown: previewPage(),
        dragIndex: null,
        // TRAKE: no confirmed/unconfirmed distinction any more -- one
        // per-video curation session (video + ordered event list, each a
        // native frame_idx with its own add-time thumbnail) feeds a
        // "Generate rows" call whose <=99 candidate sequences are cached
        // here per video_id; a final merge step interleaves however many
        // cached videos the human picked, in priority order, into one CSV.
        // See freshCurationState()/freshTrakeState() below and the
        // "TRAKE: curate one video's events..." section further down for
        // the rest.
        trake: freshTrakeState(),
        // KIS/VQA native (Keyframes unchecked): the same per-video
        // curation session shape as `trake` above (video + ordered
        // frame_idx list), minus the cache/merge fields -- one "Generate
        // rows" video isn't a thing here, the CSV is built straight from
        // whatever's curated (see the export handler's native branch).
        // Confirmed mode caps this list at one entry (replace, not
        // append); unconfirmed allows several, same temporal-order insert
        // as TRAKE events. See addEventToCuration() below.
        native: freshCurationState(),
    };
}

// Shared shape for both TRAKE's per-video curation session and KIS/VQA's
// native (Keyframes-unchecked) one -- `trake` uses every field below plus
// its own cache/merge fields (freshTrakeState() further down layers those
// on top); `native` uses this as-is.
function freshCurationState() {
    return {
        videoId: null,
        events: [],       // [{frame_idx, thumbnail}] -- TRAKE keeps this in temporal (frame_idx) order; native unconfirmed mode is insertion order instead (see addEventToCuration)
        dragIndex: null,
        videoEl: null,     // the curation panel's live <video>, for Add/capture
        unbindSpeedShortcut: null, // bindSpeedShortcut()'s cleanup for the current videoEl
        fps: 25,
    };
}

function freshTrakeState() {
    return {
        ...freshCurationState(),
        // video_id -> {frameIdxs: [...], rows: [[f1..fN], ...]} -- one
        // entry per "Generate rows" click; overwritten if regenerated for
        // the same video_id.
        cache: new Map(),
        mergeOrder: [],    // video_ids, in merge priority order (checked ones only need be present)
        mergeChecked: new Set(),
        mergeDragIndex: null,
    };
}

export function frameKey(f) { return `${f.video_id}|${f.n}`; }

// Kicks off a fetch for `f`'s frame_idx if it isn't cached yet; callers
// that already have a cached value use it directly when building their
// HTML (see renderAnswerContent()) rather than going through here, so
// `onReady` only ever fires asynchronously, after a genuine network round
// trip -- never synchronously/re-entrantly. (It used to fire synchronously
// for already-cached frames too, which re-entered renderAnswerContent()
// from inside its own answers.forEach(), recursing once per already-cached
// card; with more than a couple of cards that overflowed the call stack,
// and since the throw happened inside this function's own promise chain,
// its .catch() silently swallowed it and deleted the just-fetched cache
// entry -- so a newly-added card's frame_idx never appeared, stuck on "…"
// forever, with no visible error.)
export function ensureFrameInfo(s, f, onReady) {
    const key = frameKey(f);
    const cached = s.frameInfo.get(key);
    if (cached) return; // already resolved-and-rendered, or a fetch is already in flight
    s.frameInfo.set(key, "pending");
    getExportFrame(f.video_id, f.n).then((info) => {
        s.frameInfo.set(key, info);
        onReady(info);
    }).catch(() => { s.frameInfo.delete(key); });
}
