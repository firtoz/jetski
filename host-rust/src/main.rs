//! Host executable. Installation/forced-command selection stays explicitly opt-in.
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|arg| arg.to_str()) {
        Some("__control-directory") | Some("__control-file") => {
            let result = (|| {
                let strings: Vec<_> = args
                    .iter()
                    .map(|v| {
                        v.to_str().ok_or_else(|| {
                            std::io::Error::other("invalid_control_transfer_argument")
                        })
                    })
                    .collect::<std::io::Result<_>>()?;
                if strings[0] == "__control-directory" && strings.len() == 4 {
                    jetski_host::control_files::entry(
                        strings[1],
                        strings[2],
                        std::path::Path::new(strings[3]),
                        None,
                    )
                } else if strings[0] == "__control-file" && strings.len() == 5 {
                    let length = strings[3]
                        .parse()
                        .map_err(|_| std::io::Error::other("invalid_control_transfer_extent"))?;
                    jetski_host::control_files::entry(
                        strings[1],
                        "read",
                        std::path::Path::new(strings[2]),
                        Some((length, strings[4])),
                    )
                } else {
                    Err(std::io::Error::other("invalid_control_transfer_arguments"))
                }
            })();
            if result.is_err() {
                eprintln!("native transfer unavailable or uncertain; inspect original receipts");
                std::process::exit(1);
            }
        }
        Some("__control") if args.len() == 2 => {
            let result = args[1]
                .to_str()
                .ok_or_else(|| std::io::Error::other("invalid_native_identity"))
                .and_then(jetski_host::control_io::entry);
            if let Err(error) = result {
                // These are bounded domain/OS errors on an authenticated control
                // channel. Do not print request bodies, configuration or argv.
                eprintln!("native control failed: {error}; inspect original receipts");
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
