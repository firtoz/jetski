//! Host executable. Installation/forced-command selection stays explicitly opt-in.
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|arg| arg.to_str()) {
        Some("__control") if args.len() == 2 => {
            if args[1]
                .to_str()
                .is_none_or(|sha| jetski_host::control_io::entry(sha).is_err())
            {
                eprintln!("native control unavailable or uncertain; inspect original receipts");
                std::process::exit(1);
            }
        }
        Some("__host-group") => {
            if jetski_host::process::detached_exec(args.into_iter().skip(1).collect()).is_err() {
                std::process::exit(126);
            }
        }
        Some("__worker") => {
            let result = (|| {
                if args.len() != 3 {
                    return Err(std::io::Error::other("worker_command_id_required"));
                }
                let command = args[1]
                    .to_str()
                    .ok_or_else(|| std::io::Error::other("invalid_command_id"))?;
                let raw = args[2]
                    .to_str()
                    .ok_or_else(|| std::io::Error::other("invalid_identity"))?;
                let lease = serde_json::from_str(raw)
                    .map_err(|_| std::io::Error::other("invalid_identity"))?;
                jetski_host::worker::entry(command, &lease)
            })();
            if result.is_err() {
                eprintln!("native worker unavailable or uncertain; inspect original receipts");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("experimental Rust host backend: lifecycle integration incomplete");
            std::process::exit(1);
        }
    }
}
