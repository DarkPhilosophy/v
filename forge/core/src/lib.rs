//! Vencord Forge engine. Distribution-agnostic: what gets built comes from the distribution's
//! `forge.json`; this crate knows how to fetch, patch, build and install any such distribution
//! into any Discord channel on Linux, Windows and macOS.

pub mod asar;
pub mod bootstrap;
pub mod detect;
pub mod fsutil;
pub mod manifest;
pub mod net;
pub mod patch;
pub mod paths;
pub mod pipeline;
pub mod process;
pub mod profile;
pub mod runtime_store;
pub mod themes;
pub mod toolchain;
pub mod userplugins;
