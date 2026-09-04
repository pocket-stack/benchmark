//! pocket-bench — the bench shell's core entry.
//!
//! Sits on `pocketjs-symbian-core`'s C ABI (every `ui_*` op, `ui_tick`,
//! `ui_render*`, the `host-allocator` hooks — all re-exported through this
//! staticlib) and adds what a benchmark needs and a device host does not:
//!
//! - `pb_draw` / `pb_words_hash`: layout + DrawList as a word slice, hashed
//!   with the core's `ui_draw_hash` algorithm (FNV-1a 64 over LE bytes), so
//!   the shell times `draw` and `render` separately and compares DrawLists
//!   with the wasm oracle;
//! - `pb_render_rgba8`: the core software rasterizer
//!   over caller-owned framebuffers, from any word slice (the `raster` mode
//!   feeds DrawListTape words; `full` feeds the words `pb_draw` produced);
//! - `pb_replay_*`: the MutationTape replayer (`native` mode): applies one
//!   frame's ops to the `Ui`, maps tape ids to live ids, and checks every
//!   recorded return value against what the core actually returned;
//! - `pb_tick` / `pb_set_tick_rate`.
//!
//! `no_std`; the panic handler and the global allocator come from
//! `pocketjs-symbian-core` (`bare-platform` + `host-allocator`), so the shell
//! provides `pocket_host_alloc / realloc / free` (its static arena) and
//! `rust_eh_personality`. Tape constants come from `tape_spec.rs`, generated
//! by `spec/gen-rust.ts` from `spec/tape.ts` — never hand-edited.

#![no_std]
#![allow(static_mut_refs)]
#![allow(clippy::missing_safety_doc)]

extern crate alloc;

mod tape_spec;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use pocketjs_core::{raster, Ui};
use pocketjs_symbian_core::with_initialized_ui_unchecked;
use tape_spec as ts;

fn with_bench_ui<R>(f: impl FnOnce(&mut Ui) -> R) -> R {
    // The C shell is single-threaded. It initializes and shuts down the C ABI
    // outside these calls, and none of the closures re-enter an ui_* symbol.
    unsafe { with_initialized_ui_unchecked(f) }.expect("benchmark UI is not initialized")
}

/// C ABI version; the shell compares it with the value it was compiled against.
pub const PB_ABI_VERSION: u32 = 1;

/// Error codes shared with the shell (negative returns).
pub const PB_ERR_ARGS: i32 = -1;
pub const PB_ERR_MAGIC: i32 = -2;
pub const PB_ERR_VERSION: i32 = -3;
pub const PB_ERR_TRUNCATED: i32 = -4;
pub const PB_ERR_RECORD: i32 = -5;
pub const PB_ERR_UNKNOWN_OP: i32 = -6;
pub const PB_ERR_NOT_OPEN: i32 = -7;
pub const PB_ERR_STATE: i32 = -8;

#[no_mangle]
pub extern "C" fn pb_abi_version() -> u32 {
    PB_ABI_VERSION
}

// ---------------------------------------------------------------------------
// draw / render
// ---------------------------------------------------------------------------

/// Layout (if dirty) and DrawList. `*out_ptr` points into the core's retained
/// DrawList and stays valid until the next mutation, tick or draw.
#[no_mangle]
pub unsafe extern "C" fn pb_draw(out_ptr: *mut *const u32, out_len: *mut usize) -> i32 {
    if out_ptr.is_null() || out_len.is_null() {
        return PB_ERR_ARGS;
    }
    with_bench_ui(|ui| {
        let list = ui.draw();
        *out_ptr = list.words.as_ptr();
        *out_len = list.words.len();
    });
    0
}

/// FNV-1a 64 over the little-endian bytes of `words` — `ui_draw_hash`'s
/// algorithm, so a hash of `pb_draw`'s words equals the wasm oracle's
/// `drawHash()` for the same DrawList.
#[no_mangle]
pub unsafe extern "C" fn pb_words_hash(words: *const u32, len: usize) -> u64 {
    let words = slice_u32(words, len);
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for word in words {
        for byte in word.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

/// Bytes an RGBA8 framebuffer needs at `scale` (0 when the scale is invalid).
#[no_mangle]
pub extern "C" fn pb_framebuffer_len(scale: u32) -> usize {
    if !(1..=raster::MAX_RENDER_SCALE).contains(&scale) {
        return 0;
    }
    with_bench_ui(|ui| {
        let (w, h) = ui.viewport();
        (w as usize) * (h as usize) * (scale as usize) * (scale as usize) * 4
    })
}

/// Rasterize `words` into an RGBA8 framebuffer of exactly `pb_framebuffer_len(scale)` bytes.
#[no_mangle]
pub unsafe extern "C" fn pb_render_rgba8(
    words: *const u32,
    len: usize,
    fb: *mut u8,
    fb_len: usize,
    scale: u32,
) -> i32 {
    if fb.is_null() || pb_framebuffer_len(scale) != fb_len {
        return PB_ERR_ARGS;
    }
    let words = slice_u32(words, len);
    let fb = core::slice::from_raw_parts_mut(fb, fb_len);
    with_bench_ui(|ui| raster::render_scaled(ui, words, fb, scale));
    0
}

/// Feed a `.pak` to the core the way the PSP host does (hosts/psp/src/pak.rs):
/// `ui:styles` → load_styles, `ui:font.<slot>` → load_font_atlas,
/// `ui:img.<name>` (8-byte header `{u16 w, u16 h, u8 psm, 3B pad}` + pixels)
/// and `ui:sprite.<name>` (16-byte header, atlas pixels) → upload_texture, in
/// entry order. The native and raster modes need this so glyph runs and
/// texture quads rasterize from real assets. Returns the number of entries
/// fed, or PB_ERR_ARGS for a byte slice that is not a pak.
#[no_mangle]
pub unsafe extern "C" fn pb_load_pak(pak: *const u8, len: usize) -> i32 {
    if pak.is_null() || len == 0 {
        return PB_ERR_ARGS;
    }
    let bytes = core::slice::from_raw_parts(pak, len);
    let mut fed = 0i32;
    with_bench_ui(|ui| {
        for entry in pocketjs_core::pak::entries(bytes) {
            let key = entry.key;
            let blob = entry.blob;
            if key == "ui:styles" {
                if ui.load_styles(blob) {
                    fed += 1;
                }
            } else if key.starts_with("ui:font.") {
                if ui.load_font_atlas(blob) {
                    fed += 1;
                }
            } else if key.starts_with("ui:img.") {
                // Modern packs carry self-contained IMG entries (v2: palette,
                // RLE, filter flags — Ui::upload_img_entry parses them); the
                // 8-byte-header raw form is the PSP-era fallback. The guest
                // uploads these with uploadImgEntry in pak order, so feeding
                // them here in the same order reproduces the same handles.
                if ui.upload_img_entry(blob) >= 0 {
                    fed += 1;
                } else if blob.len() >= 8 {
                    let w = u16::from_le_bytes([blob[0], blob[1]]) as u32;
                    let h = u16::from_le_bytes([blob[2], blob[3]]) as u32;
                    let psm = blob[4] as u32;
                    if ui.upload_texture(&blob[8..], w, h, psm) >= 0 {
                        fed += 1;
                    }
                }
            } else if key.starts_with("ui:sprite.") {
                if blob.len() >= 16 {
                    let w = u16::from_le_bytes([blob[0], blob[1]]) as u32;
                    let h = u16::from_le_bytes([blob[2], blob[3]]) as u32;
                    let psm = blob[4] as u32;
                    if ui.upload_texture(&blob[16..], w, h, psm) >= 0 {
                        fed += 1;
                    }
                }
            }
        }
    });
    fed
}

#[no_mangle]
pub extern "C" fn pb_tick(count: u32) {
    with_bench_ui(|ui| {
        for _ in 0..count {
            ui.tick();
        }
    });
}

/// `Ui::set_tick_rate`; must run before the first tick. Returns 0 or PB_ERR_STATE.
#[no_mangle]
pub extern "C" fn pb_set_tick_rate(hz: u32) -> i32 {
    if with_bench_ui(|ui| ui.set_tick_rate(hz)) {
        0
    } else {
        PB_ERR_STATE
    }
}

unsafe fn slice_u32<'a>(ptr: *const u32, len: usize) -> &'a [u32] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len)
    }
}

// ---------------------------------------------------------------------------
// MutationTape replayer
// ---------------------------------------------------------------------------

/// One FRAME record, handed back to the shell so it drives ticks itself.
#[repr(C)]
pub struct PbFrame {
    pub frame_index: u32,
    pub buttons: u32,
    pub analog: u32,
    pub ticks: u32,
}

#[repr(C)]
pub struct PbTapeInfo {
    pub version: u32,
    pub host_abi: u32,
    pub source: u32,
    pub framework: u32,
    pub viewport_w: u32,
    pub viewport_h: u32,
    pub raster_density: u32,
    pub sim_hz: u32,
    pub tick_hz: u32,
    pub frame_count: u32,
    pub record_words: u32,
    pub atlas_count: u32,
}

struct Replay {
    words: Vec<u32>,
    /// Index of the next unread record header.
    pos: usize,
    /// Where the records begin; OPs found here before any FRAME are the eval segment.
    eval_start: usize,
    end: usize,
    info: PbTapeInfo,
    nodes: BTreeMap<i32, i32>,
    textures: BTreeMap<i32, i32>,
    anims: BTreeMap<i32, i32>,
    mismatches: u32,
    ops_applied: u32,
}

static mut REPLAY: Option<Replay> = None;

fn rd_u64(words: &[u32], at: usize) -> u64 {
    (words[at] as u64) | ((words[at + 1] as u64) << 32)
}

/// Parse the header, keep the tape's words, reset the id maps.
#[no_mangle]
pub unsafe extern "C" fn pb_replay_open(tape: *const u8, len: usize) -> i32 {
    pb_replay_close();
    if tape.is_null() || len < ts::MT_FIXED_WORDS * 4 || len % 4 != 0 {
        return PB_ERR_TRUNCATED;
    }
    let bytes = core::slice::from_raw_parts(tape, len);
    let mut words = Vec::with_capacity(len / 4);
    for chunk in bytes.chunks_exact(4) {
        words.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    if words[ts::MT_MAGIC] != ts::MUTATION_TAPE_MAGIC {
        return PB_ERR_MAGIC;
    }
    if words[ts::MT_VERSION] != ts::TAPE_VERSION {
        return PB_ERR_VERSION;
    }
    let header_words = words[ts::MT_HEADER_WORDS] as usize;
    let atlas_count = words[ts::MT_ATLAS_COUNT] as usize;
    if header_words < ts::MT_FIXED_WORDS + 2 * atlas_count || header_words > words.len() {
        return PB_ERR_TRUNCATED;
    }
    let record_words = words[ts::MT_RECORD_WORDS] as usize;
    let end = header_words.saturating_add(record_words);
    if end > words.len() {
        return PB_ERR_TRUNCATED;
    }
    let info = PbTapeInfo {
        version: words[ts::MT_VERSION],
        host_abi: words[ts::MT_HOST_ABI],
        source: words[ts::MT_SOURCE],
        framework: words[ts::MT_FRAMEWORK],
        viewport_w: words[ts::MT_VIEWPORT_W],
        viewport_h: words[ts::MT_VIEWPORT_H],
        raster_density: words[ts::MT_RASTER_DENSITY],
        sim_hz: words[ts::MT_SIM_HZ],
        tick_hz: words[ts::MT_TICK_HZ],
        frame_count: words[ts::MT_FRAME_COUNT],
        record_words: words[ts::MT_RECORD_WORDS],
        atlas_count: atlas_count as u32,
    };
    let _ = rd_u64; // header u64 fields are identity, not needed for replay
    REPLAY = Some(Replay {
        words,
        pos: header_words,
        eval_start: header_words,
        end,
        info,
        nodes: BTreeMap::new(),
        textures: BTreeMap::new(),
        anims: BTreeMap::new(),
        mismatches: 0,
        ops_applied: 0,
    });
    0
}

#[no_mangle]
pub unsafe extern "C" fn pb_replay_info(out: *mut PbTapeInfo) -> i32 {
    let Some(replay) = REPLAY.as_ref() else {
        return PB_ERR_NOT_OPEN;
    };
    if out.is_null() {
        return PB_ERR_ARGS;
    }
    core::ptr::write(
        out,
        PbTapeInfo {
            version: replay.info.version,
            host_abi: replay.info.host_abi,
            source: replay.info.source,
            framework: replay.info.framework,
            viewport_w: replay.info.viewport_w,
            viewport_h: replay.info.viewport_h,
            raster_density: replay.info.raster_density,
            sim_hz: replay.info.sim_hz,
            tick_hz: replay.info.tick_hz,
            frame_count: replay.info.frame_count,
            record_words: replay.info.record_words,
            atlas_count: replay.info.atlas_count,
        },
    );
    0
}

#[no_mangle]
pub unsafe extern "C" fn pb_replay_mismatches() -> u32 {
    REPLAY.as_ref().map(|r| r.mismatches).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn pb_replay_ops_applied() -> u32 {
    REPLAY.as_ref().map(|r| r.ops_applied).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn pb_replay_close() {
    REPLAY = None;
}

struct Cursor<'a> {
    words: &'a [u32],
    at: usize,
    end: usize,
}

impl<'a> Cursor<'a> {
    fn word(&mut self) -> Option<u32> {
        if self.at < self.end {
            let w = self.words[self.at];
            self.at += 1;
            Some(w)
        } else {
            None
        }
    }
    fn f64(&mut self) -> Option<f64> {
        let lo = self.word()? as u64;
        let hi = self.word()? as u64;
        Some(f64::from_bits(lo | (hi << 32)))
    }
    /// len word + ceil(len/4) words of packed little-endian bytes.
    fn bytes(&mut self) -> Option<Vec<u8>> {
        let len = self.word()? as usize;
        let words = (len + 3) / 4;
        if self.at + words > self.end {
            return None;
        }
        let mut out = Vec::with_capacity(len);
        for i in 0..words {
            let bytes = self.words[self.at + i].to_le_bytes();
            let take = core::cmp::min(4, len - out.len());
            out.extend_from_slice(&bytes[..take]);
        }
        self.at += words;
        Some(out)
    }
}

fn map_node(replay: &Replay, tape_id: i32) -> i32 {
    if tape_id == 0 || tape_id == 1 {
        return tape_id; // none / ROOT_ID
    }
    replay.nodes.get(&tape_id).copied().unwrap_or(tape_id)
}

fn map_texture(replay: &Replay, tape_handle: i32) -> i32 {
    if tape_handle < 0 {
        return tape_handle;
    }
    replay
        .textures
        .get(&tape_handle)
        .copied()
        .unwrap_or(tape_handle)
}

fn map_anim(replay: &Replay, tape_id: i32) -> i32 {
    replay.anims.get(&tape_id).copied().unwrap_or(tape_id)
}

/// Read the RET record that must follow `op`; returns its value word(s).
fn take_ret(cursor: &mut Cursor<'_>, expect_kind: u32) -> Result<u32, i32> {
    let header = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
    if header & ts::RECORD_KIND_MASK != ts::RECORD_RET {
        return Err(PB_ERR_RECORD);
    }
    let payload = (header >> ts::RECORD_PAYLOAD_SHIFT) as usize;
    let kind = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
    if kind != expect_kind || payload < 2 {
        return Err(PB_ERR_RECORD);
    }
    let value = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
    // Skip anything a newer writer appended to the RET payload.
    for _ in 2..payload {
        cursor.word().ok_or(PB_ERR_TRUNCATED)?;
    }
    Ok(value)
}

/// Apply one OP record (header already consumed) and its RET, if any.
fn apply_op(
    replay: &mut Replay,
    ui: &mut Ui,
    cursor: &mut Cursor<'_>,
    payload: usize,
) -> Result<(), i32> {
    let start = cursor.at;
    let op = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
    let spec = ts::op_spec(op).ok_or(PB_ERR_UNKNOWN_OP)?;
    // Decode the arguments by the generated layout so a tape never depends on
    // hand-written offsets; the dispatch below consumes them positionally.
    enum Arg {
        W(u32),
        D(f64),
        B(Vec<u8>),
    }
    let mut args: Vec<Arg> = Vec::with_capacity(spec.layout.len());
    for ch in spec.layout.bytes() {
        let arg = match ch {
            b'i' | b'u' | b'f' => Arg::W(cursor.word().ok_or(PB_ERR_TRUNCATED)?),
            b'd' => Arg::D(cursor.f64().ok_or(PB_ERR_TRUNCATED)?),
            b's' | b'b' => Arg::B(cursor.bytes().ok_or(PB_ERR_TRUNCATED)?),
            _ => return Err(PB_ERR_RECORD),
        };
        args.push(arg);
    }
    if cursor.at - start > payload {
        return Err(PB_ERR_RECORD);
    }
    // Skip padding a newer writer may append after the known arguments.
    cursor.at = start + payload;

    fn w(args: &[Arg], i: usize) -> u32 {
        match args.get(i) {
            Some(Arg::W(v)) => *v,
            _ => 0,
        }
    }
    fn i(args: &[Arg], idx: usize) -> i32 {
        w(args, idx) as i32
    }
    fn f(args: &[Arg], idx: usize) -> f32 {
        f32::from_bits(w(args, idx))
    }
    fn d(args: &[Arg], idx: usize) -> f64 {
        match args.get(idx) {
            Some(Arg::D(v)) => *v,
            _ => 0.0,
        }
    }
    fn b(args: &[Arg], idx: usize) -> &[u8] {
        match args.get(idx) {
            Some(Arg::B(v)) => v.as_slice(),
            _ => &[],
        }
    }
    fn s(args: &[Arg], idx: usize) -> &str {
        core::str::from_utf8(b(args, idx)).unwrap_or("")
    }

    match op {
        ts::OP_CREATE_NODE => {
            let live = ui.create_node(w(&args, 0) as u8);
            let recorded = take_ret(cursor, ts::RET_I32)? as i32;
            replay.nodes.insert(recorded, live);
        }
        ts::OP_DESTROY_NODE => ui.destroy_node(map_node(replay, i(&args, 0))),
        ts::OP_INSERT_BEFORE => ui.insert_before(
            map_node(replay, i(&args, 0)),
            map_node(replay, i(&args, 1)),
            map_node(replay, i(&args, 2)),
        ),
        ts::OP_REMOVE_CHILD => {
            ui.remove_child(map_node(replay, i(&args, 0)), map_node(replay, i(&args, 1)))
        }
        ts::OP_SET_STYLE => ui.set_style(map_node(replay, i(&args, 0)), i(&args, 1)),
        ts::OP_SET_PROP => ui.set_prop(
            map_node(replay, i(&args, 0)),
            w(&args, 1) as u8,
            d(&args, 2),
        ),
        ts::OP_SET_TEXT => ui.set_text(map_node(replay, i(&args, 0)), s(&args, 1)),
        ts::OP_REPLACE_TEXT => ui.replace_text(map_node(replay, i(&args, 0)), s(&args, 1)),
        ts::OP_UPLOAD_TEXTURE => {
            let live = ui.upload_texture(b(&args, 0), w(&args, 1), w(&args, 2), w(&args, 3));
            let recorded = take_ret(cursor, ts::RET_I32)? as i32;
            replay.textures.insert(recorded, live);
        }
        ts::OP_UPLOAD_IMG_ENTRY => {
            let live = ui.upload_img_entry(b(&args, 0));
            let recorded = take_ret(cursor, ts::RET_I32)? as i32;
            replay.textures.insert(recorded, live);
        }
        ts::OP_FREE_TEXTURE => ui.free_texture(map_texture(replay, i(&args, 0))),
        ts::OP_SET_IMAGE => ui.set_image(
            map_node(replay, i(&args, 0)),
            map_texture(replay, i(&args, 1)),
        ),
        ts::OP_SET_SPRITE => ui.set_sprite(
            map_node(replay, i(&args, 0)),
            map_texture(replay, i(&args, 1)),
            w(&args, 2),
            w(&args, 3),
            w(&args, 4),
        ),
        ts::OP_ANIMATE => {
            let live = ui.animate(
                map_node(replay, i(&args, 0)),
                w(&args, 1) as u8,
                d(&args, 2),
                w(&args, 3),
                w(&args, 4) as u8,
                w(&args, 5),
            );
            let recorded = take_ret(cursor, ts::RET_I32)? as i32;
            replay.anims.insert(recorded, live);
        }
        ts::OP_CANCEL_ANIM => ui.cancel_anim(map_anim(replay, i(&args, 0))),
        ts::OP_SET_FOCUS => ui.set_focus(map_node(replay, i(&args, 0))),
        ts::OP_SET_ACTIVE => ui.set_active(map_node(replay, i(&args, 0)), i(&args, 1) != 0),
        ts::OP_HIT_TEST | ts::OP_HIT_TEST_BOUNDS => {
            let live = if op == ts::OP_HIT_TEST {
                ui.hit_test(f(&args, 0), f(&args, 1))
            } else {
                ui.hit_test_bounds(f(&args, 0), f(&args, 1))
            };
            let recorded = take_ret(cursor, ts::RET_I32)? as i32;
            if map_node(replay, recorded) != live {
                replay.mismatches += 1;
            }
        }
        ts::OP_SET_CURSOR => ui.set_cursor(
            map_texture(replay, i(&args, 0)),
            f(&args, 1),
            f(&args, 2),
            f(&args, 3),
            f(&args, 4),
        ),
        ts::OP_SET_CURSOR_POS => ui.set_cursor_pos(f(&args, 0), f(&args, 1)),
        ts::OP_LOAD_STYLES => {
            ui.load_styles(b(&args, 0));
        }
        ts::OP_LOAD_FONT_ATLAS => {
            ui.load_font_atlas(b(&args, 0));
        }
        ts::OP_MEASURE_TEXT => {
            let live = ui.measure_text(s(&args, 0), w(&args, 1) as u8);
            let recorded = f32::from_bits(take_ret(cursor, ts::RET_F32)?);
            if recorded.to_bits() != live.to_bits() {
                replay.mismatches += 1;
            }
        }
        ts::OP_WRAP_TEXT => {
            // Not bound by pocket_runtime.c; a tape can still carry it. Apply
            // and check the break columns.
            let live = ui.wrap_text(s(&args, 0), w(&args, 1) as u8, f(&args, 2));
            let header = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
            if header & ts::RECORD_KIND_MASK != ts::RECORD_RET {
                return Err(PB_ERR_RECORD);
            }
            let payload = (header >> ts::RECORD_PAYLOAD_SHIFT) as usize;
            let kind = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
            let count = cursor.word().ok_or(PB_ERR_TRUNCATED)? as usize;
            if kind != ts::RET_U32_ARRAY || payload != 2 + count {
                return Err(PB_ERR_RECORD);
            }
            let mut equal = live.len() == count;
            for idx in 0..count {
                let recorded = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
                if equal && live[idx] != recorded {
                    equal = false;
                }
            }
            if !equal {
                replay.mismatches += 1;
            }
        }
        ts::OP_LOAD_TILE_TEXTURE => {
            // Needs the pak; the shell has none in native mode. Keep the id
            // map coherent with the recording and count it as a mismatch.
            let recorded = take_ret(cursor, ts::RET_I32)? as i32;
            replay.textures.insert(recorded, -1);
            replay.mismatches += 1;
        }
        _ => return Err(PB_ERR_UNKNOWN_OP),
    }
    replay.ops_applied += 1;
    Ok(())
}

/// `PbFrame::frame_index` of the eval segment: the OPs a recording made
/// before its first FRAME (module evaluation, mount). It carries no ticks.
pub const PB_EVAL_SEGMENT: u32 = u32::MAX;

/// Consume the next FRAME record and every OP up to the following FRAME or
/// END, applying them to the core. A tape whose records start with OPs
/// yields those first as the eval segment (`frame_index == PB_EVAL_SEGMENT`,
/// `ticks == 0`). Returns 1 with `out` filled, 0 at END, or a negative
/// PB_ERR_* code.
#[no_mangle]
pub unsafe extern "C" fn pb_replay_next(out: *mut PbFrame) -> i32 {
    let Some(replay) = REPLAY.as_mut() else {
        return PB_ERR_NOT_OPEN;
    };
    if out.is_null() {
        return PB_ERR_ARGS;
    }
    let result = with_bench_ui(|ui| replay_frame(replay, ui, out));
    match result {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(code) => code,
    }
}

unsafe fn replay_frame(replay: &mut Replay, ui: &mut Ui, out: *mut PbFrame) -> Result<bool, i32> {
    let words = core::mem::take(&mut replay.words);
    let outcome = (|| {
        let mut cursor = Cursor {
            words: &words,
            at: replay.pos,
            end: replay.end,
        };
        // FRAME (or END) first — unless the tape opens with the eval segment.
        let header = *cursor.words.get(cursor.at).ok_or(PB_ERR_TRUNCATED)?;
        let kind = header & ts::RECORD_KIND_MASK;
        let payload = (header >> ts::RECORD_PAYLOAD_SHIFT) as usize;
        if kind == ts::RECORD_END {
            replay.pos = cursor.at + 1;
            return Ok(false);
        }
        if kind == ts::RECORD_FRAME {
            cursor.at += 1;
            if payload < ts::FRAME_FIXED_WORDS {
                return Err(PB_ERR_RECORD);
            }
            let frame_index = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
            let buttons = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
            let analog = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
            let ticks = cursor.word().ok_or(PB_ERR_TRUNCATED)?;
            let touch_words = cursor.word().ok_or(PB_ERR_TRUNCATED)? as usize;
            if payload != ts::FRAME_FIXED_WORDS + touch_words {
                return Err(PB_ERR_RECORD);
            }
            cursor.at += touch_words;
            core::ptr::write(
                out,
                PbFrame {
                    frame_index,
                    buttons,
                    analog,
                    ticks,
                },
            );
        } else if kind == ts::RECORD_OP && replay.pos == replay.eval_start {
            // Records before the first FRAME: the eval segment.
            core::ptr::write(
                out,
                PbFrame {
                    frame_index: PB_EVAL_SEGMENT,
                    buttons: 0,
                    analog: 0,
                    ticks: 0,
                },
            );
        } else {
            return Err(PB_ERR_RECORD);
        }
        // OPs until the next FRAME / END (left unconsumed for the next call).
        loop {
            if cursor.at >= cursor.end {
                break;
            }
            let header = cursor.words[cursor.at];
            let kind = header & ts::RECORD_KIND_MASK;
            let payload = (header >> ts::RECORD_PAYLOAD_SHIFT) as usize;
            if kind == ts::RECORD_FRAME || kind == ts::RECORD_END {
                break;
            }
            cursor.at += 1;
            match kind {
                ts::RECORD_OP => apply_op(replay, ui, &mut cursor, payload)?,
                ts::RECORD_RET => return Err(PB_ERR_RECORD), // a RET must follow its OP
                _ => cursor.at += payload,                   // unknown record: skip by length
            }
        }
        replay.pos = cursor.at;
        Ok(true)
    })();
    replay.words = words;
    outcome
}
