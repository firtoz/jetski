use jetski_host::process::BoundedCommand;
use std::path::PathBuf;
use std::time::Duration;
fn runner(temp: &tempfile::TempDir) -> BoundedCommand {
    BoundedCommand {
        executable: PathBuf::from(env!("CARGO_BIN_EXE_jetski-host")),
        scratch: temp.path().into(),
    }
}
#[test]
fn native_helper_preserves_exact_exit_and_strips_inherited_environment() {
    let temp = tempfile::tempdir().unwrap();
    let result = runner(&temp)
        .run(
            &[
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s|%s' \"$HOME\" \"$LANG\"; printf error >&2; exit 7".into(),
            ],
            Duration::from_secs(2),
            1024,
        )
        .unwrap();
    assert_eq!(result.exit_code, 7);
    assert_eq!(result.stdout, "|C.UTF-8");
    assert_eq!(result.stderr, "error");
}
#[test]
fn timeout_and_excessive_output_cannot_report_success() {
    let temp = tempfile::tempdir().unwrap();
    assert!(
        runner(&temp)
            .run(
                &["/bin/sleep".into(), "2".into()],
                Duration::from_millis(60),
                1024
            )
            .is_err()
    );
    assert!(
        runner(&temp)
            .run(
                &[
                    "/usr/bin/head".into(),
                    "-c".into(),
                    "4096".into(),
                    "/dev/zero".into()
                ],
                Duration::from_secs(2),
                1024
            )
            .is_err()
    );
}
