//! Versioned workload command specification; never interpreted by a host shell.
use crate::files::components;
use serde::{Deserialize, Serialize};
use std::io;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Specification {
    pub argv: Vec<String>,
    pub cwd: String,
    pub timeout: u32,
    pub terminal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u16>,
}
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
impl Specification {
    pub fn new(
        argv: Vec<String>,
        cwd: String,
        timeout: u32,
        geometry: Option<(u16, u16)>,
    ) -> io::Result<Self> {
        let spec = Self {
            argv,
            cwd,
            timeout,
            terminal: geometry.is_some(),
            rows: geometry.map(|v| v.0),
            columns: geometry.map(|v| v.1),
        };
        spec.validate()?;
        Ok(spec)
    }
    pub fn validate(&self) -> io::Result<()> {
        if !(1..=256).contains(&self.argv.len())
            || self.argv[0].is_empty()
            || self.argv.iter().any(|a| a.contains('\0'))
        {
            return Err(reject("invalid_command_argv"));
        }
        // Python reference uses json.dumps defaults: ASCII escapes and comma spaces.
        let mut encoded = 2 + self.argv.len().saturating_sub(1) * 2;
        for arg in &self.argv {
            encoded += 2;
            for character in arg.chars() {
                encoded = encoded.saturating_add(match character {
                    '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
                    c if c < ' ' => 6,
                    c if c.is_ascii() => 1,
                    c if (c as u32) <= 0xffff => 6,
                    _ => 12,
                });
                if encoded > 65536 {
                    return Err(reject("command_input_limit"));
                }
            }
        }
        components(&self.cwd).map_err(|_| reject("invalid_command_cwd"))?;
        if !(1..=3600).contains(&self.timeout) {
            return Err(reject("invalid_command_timeout"));
        }
        match (self.terminal, self.rows, self.columns) {
            (false, None, None) => {}
            (true, Some(rows), Some(columns))
                if (1..=4096).contains(&rows) && (1..=4096).contains(&columns) => {}
            _ => return Err(reject("invalid_terminal_geometry")),
        }
        Ok(())
    }
}
