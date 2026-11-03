//! Optional stderr diagnostics, never a durable operation receipt.
use std::{
    io::{self, Write},
    time::Instant,
};

pub struct Stage {
    started: Option<Instant>,
    name: &'static str,
}
impl Stage {
    pub fn new(name: &'static str) -> Self {
        Self {
            started: (std::env::var_os("JETSKI_HOST_TIMING").as_deref()
                == Some(std::ffi::OsStr::new("1")))
            .then(Instant::now),
            name,
        }
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if let Some(started) = self.started {
            // Drop cannot know Result success: parent control completion is authoritative.
            let record = serde_json::json!({"stage":self.name,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,"outcome":"observed"});
            let _ = writeln!(io::stderr().lock(), "JETSKI-STAGE/1:{record}");
        }
    }
}
