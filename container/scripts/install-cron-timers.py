#!/usr/bin/env python3
"""Write melvbot cron systemd units from cron_jobs.db."""

from __future__ import annotations

import argparse
import re
import sqlite3
import subprocess
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path

_SYSTEMD_DIR = Path("/etc/systemd/system")
_CRON_DOW = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
_CALENDAR_TZ = "Asia/Singapore"
_UNIT_HEADER = re.compile(r"^# (melvbot-cron-[0-9a-f]+\.(?:service|timer))$")
# Kept in sync with melvbot.cron.store.TRIGGERED. This script stays stdlib-only so
# it can run on the host without the project venv, hence the duplicate constant.
_TRIGGERED = "triggered"
# Kept in sync with melvbot.cron.store. StartLimit* are [Unit] keys; Restart* are
# [Service]. Interval must cover StartLimitBurst starts that each last up to
# TimeoutStartSec+RestartSec, or a hung exec eats the window and burst never trips.
_BUSY_TIMEOUT_MS = 5000
_TIMEOUT_START_SEC = 900
_RESTART_SEC = 30
_START_LIMIT_BURST = 3
_START_LIMIT_INTERVAL_SEC = _START_LIMIT_BURST * (
    _TIMEOUT_START_SEC + _RESTART_SEC
)
_CONTAINER_WAIT_SEC = 60
_PATH_UNIT_NAME = "melvbot-timer-sync.path"
_SYNC_SERVICE_NAME = "melvbot-timer-sync.service"
_HOURLY_TIMER_NAME = "melvbot-timer-sync.timer"
_PATH_UNIT_SRC = Path(__file__).resolve().parent.parent / "deploy" / _PATH_UNIT_NAME
_SYNC_SERVICE_SRC = _PATH_UNIT_SRC.with_name(_SYNC_SERVICE_NAME)


# Hour may be exactly ``*`` only when every minute token is a digit (comma-list).
HOUR_STAR_REQUIRES_DIGIT_MINUTES = True


def _cron_clock_field(field: str, *, name: str) -> str:
    if field.strip() == "*":
        raise ValueError(f"unsupported cron {name} field: {field!r}")
    parts: list[str] = []
    for raw in field.split(","):
        token = raw.strip()
        if not token.isdigit():
            raise ValueError(f"unsupported cron {name} field: {field!r}")
        parts.append(f"{int(token):02d}")
    return ",".join(parts)


def _cron_hour_field(hour: str, minute: str) -> str:
    if hour.strip() != "*":
        return _cron_clock_field(hour, name="hour")
    if not HOUR_STAR_REQUIRES_DIGIT_MINUTES:
        raise ValueError(f"unsupported cron hour field: {hour!r}")
    for raw in minute.split(","):
        if not raw.strip().isdigit():
            raise ValueError(f"unsupported cron hour field: {hour!r}")
    return "*"


def _dow_name(number: int) -> str:
    if number == 7:
        number = 0
    if number < 0 or number > 6:
        raise ValueError(f"unsupported cron dow: {number}")
    return _CRON_DOW[number]


def _dow_token(token: str) -> str:
    if token.isdigit():
        return _dow_name(int(token))
    if "-" in token:
        left_s, right_s = token.split("-", 1)
        if left_s.isdigit() and right_s.isdigit():
            return f"{_dow_name(int(left_s))}..{_dow_name(int(right_s))}"
    raise ValueError(f"unsupported cron dow field: {token!r}")


def _dow_field(field: str) -> str:
    names = [_dow_token(raw.strip()) for raw in field.split(",") if raw.strip()]
    if not names:
        raise ValueError(f"unsupported cron dow field: {field!r}")
    return ",".join(names)


def cron_to_systemd_calendar(expr: str) -> str:
    minute, hour, dom, month, dow = expr.split()
    if month != "*":
        raise ValueError(f"unsupported month field: {expr!r}")
    clock = (
        f"{_cron_hour_field(hour, minute)}:"
        f"{_cron_clock_field(minute, name='minute')}:00"
    )
    if dom != "*" and dow == "*":
        calendar = f"*-*-{int(dom):02d} {clock}"
    elif dow != "*" and dom == "*":
        calendar = f"{_dow_field(dow)} *-*-* {clock}"
    elif dom == "*" and dow == "*":
        calendar = f"*-*-* {clock}"
    else:
        raise ValueError(f"unsupported cron day fields: {expr!r}")
    return f"{calendar} {_CALENDAR_TZ}"


def _is_five_field_cron(text: str) -> bool:
    return len(text.split()) == 5


def _is_systemd_calendar(text: str) -> bool:
    return ":" in text or "*-*" in text


def _ensure_timezone(calendar: str) -> str:
    if calendar.split()[-1] == _CALENDAR_TZ:
        return calendar
    return f"{calendar} {_CALENDAR_TZ}"


def _render_calendar(text: str) -> str:
    if _is_five_field_cron(text):
        return cron_to_systemd_calendar(text)
    if _is_systemd_calendar(text):
        return _ensure_timezone(text)
    raise ValueError(f"unsupported calendar: {text!r}")


def calendar_for_job(on_calendar: str | None, schedule: str) -> str:
    primary = (on_calendar or "").strip()
    fallback = schedule.strip()
    chosen = primary or fallback
    if chosen.lower() == _TRIGGERED:
        return _TRIGGERED
    try:
        return _render_calendar(chosen)
    except ValueError:
        if fallback and fallback != chosen:
            return _render_calendar(fallback)
        raise


def _wait_for_container(container_name: str) -> str:
    return (
        "/bin/sh -c '"
        f'n=0; while [ "$n" -lt {_CONTAINER_WAIT_SEC} ]; do '
        f'if [ "$(/usr/bin/docker inspect -f "{{{{.State.Running}}}}" '
        f'{container_name} 2>/dev/null)" = true ]; '
        "then exit 0; fi; n=$((n+1)); sleep 1; done; exit 1'"
    )


def cron_job_service_unit(
    *, job_id: str, name: str, container_name: str = "melvbot"
) -> str:
    if job_id == "idle_reset":
        return f"""[Unit]
Description=Melvbot cron job {name}
After=docker.service

[Service]
Type=oneshot
TimeoutStartSec={_TIMEOUT_START_SEC}
Restart=no
ExecStartPre={_wait_for_container(container_name)}
ExecStart=/usr/bin/docker exec {container_name} melvbot cron run-once {job_id}
"""
    return f"""[Unit]
Description=Melvbot cron job {name}
After=docker.service
StartLimitBurst={_START_LIMIT_BURST}
StartLimitIntervalSec={_START_LIMIT_INTERVAL_SEC}

[Service]
Type=oneshot
TimeoutStartSec={_TIMEOUT_START_SEC}
Restart=on-failure
RestartSec={_RESTART_SEC}
ExecStartPre={_wait_for_container(container_name)}
ExecStart=/usr/bin/docker exec {container_name} melvbot cron run-once {job_id}
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=_BUSY_TIMEOUT_MS / 1000)
    conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
    return conn


def write_units_from_db(
    *,
    db_path: Path,
    out_dir: Path,
    container_name: str = "melvbot",
) -> tuple[list[Path], list[str]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id, name, schedule, on_calendar FROM cron_jobs "
            "WHERE enabled=1 ORDER BY name"
        ).fetchall()
    written: list[Path] = []
    skipped: list[str] = []
    for job_id, name, schedule, on_calendar in rows:
        unit = f"melvbot-cron-{job_id}"
        service_path = out_dir / f"{unit}.service"
        timer_path = out_dir / f"{unit}.timer"
        try:
            calendar = calendar_for_job(on_calendar, schedule)
        except ValueError as exc:
            print(f"skip {unit}: {exc}", file=sys.stderr)
            skipped.append(job_id)
            continue
        service_path.write_text(
            cron_job_service_unit(
                job_id=job_id, name=name, container_name=container_name
            ),
            encoding="utf-8",
        )
        # A triggered job is started by whatever finished before it, so giving it
        # a timer would fire it a second time on the clock.
        if calendar.lower() == _TRIGGERED:
            written.append(service_path)
            continue
        timer_path.write_text(
            f"""[Unit]
Description=Melvbot cron timer {name}

[Timer]
OnCalendar={calendar}
Persistent=true
Unit={unit}.service

[Install]
WantedBy=timers.target
""",
            encoding="utf-8",
        )
        written.extend([service_path, timer_path])
    return written, skipped


def split_install_timers_output(text: str, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    current_name: str | None = None
    current_lines: list[str] = []
    written: list[Path] = []

    def flush() -> None:
        nonlocal current_name, current_lines
        if current_name is None:
            return
        path = out_dir / current_name
        path.write_text("".join(current_lines), encoding="utf-8")
        written.append(path)
        current_name = None
        current_lines = []

    for line in text.splitlines(keepends=True):
        header = _UNIT_HEADER.match(line.strip())
        if header:
            flush()
            current_name = header.group(1)
            current_lines = []
            continue
        if current_name is not None:
            current_lines.append(line)
    flush()
    return written


def stale_units(*, installed: Iterable[str], staged: Iterable[str]) -> list[str]:
    keep = set(staged)
    return sorted(name for name in installed if name not in keep)


def drop_hourly_timer_sync(*, systemd_dir: Path = _SYSTEMD_DIR) -> bool:
    # Passwordless sudo is the cron-sync wrapper, not ad-hoc systemctl.
    # Skip when the unit file is already gone so later syncs do not print
    # "Failed to disable unit: Unit file ... does not exist".
    # Stop before disable: disable alone leaves an already-queued firing.
    path = systemd_dir / _HOURLY_TIMER_NAME
    if not path.is_file():
        return False
    subprocess.run(
        ["sudo", "systemctl", "stop", _HOURLY_TIMER_NAME], check=False
    )
    subprocess.run(
        ["sudo", "systemctl", "disable", _HOURLY_TIMER_NAME], check=False
    )
    subprocess.run(["sudo", "rm", "-f", str(path)], check=False)
    print(f"removed {_HOURLY_TIMER_NAME}")
    return True


def install_units(unit_dir: Path, *, systemd_dir: Path = _SYSTEMD_DIR) -> None:
    staged = sorted(unit_dir.glob("melvbot-cron-*"))
    timers = [path for path in staged if path.suffix == ".timer"]
    if not timers:
        raise SystemExit(f"no timer units found in {unit_dir}")
    subprocess.run(
        ["sudo", "cp", *[str(p) for p in staged], f"{systemd_dir}/"],
        check=True,
    )
    if not _PATH_UNIT_SRC.is_file():
        raise SystemExit(f"missing path unit: {_PATH_UNIT_SRC}")
    if not _SYNC_SERVICE_SRC.is_file():
        raise SystemExit(f"missing sync service: {_SYNC_SERVICE_SRC}")
    subprocess.run(
        ["sudo", "cp", str(_PATH_UNIT_SRC), str(systemd_dir / _PATH_UNIT_NAME)],
        check=True,
    )
    subprocess.run(
        [
            "sudo",
            "cp",
            str(_SYNC_SERVICE_SRC),
            str(systemd_dir / _SYNC_SERVICE_NAME),
        ],
        check=True,
    )
    subprocess.run(["sudo", "systemctl", "daemon-reload"], check=True)
    for timer in timers:
        subprocess.run(["sudo", "systemctl", "enable", "--now", timer.name], check=True)
        print(f"enabled {timer.name}")
    subprocess.run(
        ["sudo", "systemctl", "enable", "--now", _PATH_UNIT_NAME],
        check=True,
    )
    print(f"enabled {_PATH_UNIT_NAME}")
    dropped_hourly = drop_hourly_timer_sync(systemd_dir=systemd_dir)
    # Copying the new set over the old one leaves anything that lost its timer —
    # or whose job was deleted — still installed and still firing.
    orphans = stale_units(
        installed=[path.name for path in systemd_dir.glob("melvbot-cron-*")],
        staged=[path.name for path in staged],
    )
    for name in orphans:
        if name.endswith(".timer"):
            subprocess.run(["sudo", "systemctl", "disable", "--now", name], check=False)
        subprocess.run(["sudo", "rm", "-f", str(systemd_dir / name)], check=False)
        print(f"removed {name}")
    if dropped_hourly or orphans:
        subprocess.run(["sudo", "systemctl", "daemon-reload"], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        default=str(Path.home() / "melvbot-workspace/melvbot-data/config/cron_jobs.db"),
    )
    parser.add_argument("--container", default="melvbot")
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()

    # A fixed staging path breaks the next non-root run: one `sudo` invocation
    # leaves /tmp/melvbot-cron-units owned by root, and mkdir(exist_ok=True) then
    # succeeds while every write fails.
    out_dir = args.out_dir or Path(tempfile.mkdtemp(prefix="melvbot-cron-units-"))
    written, skipped = write_units_from_db(
        db_path=Path(args.db),
        out_dir=out_dir,
        container_name=args.container,
    )
    print(f"wrote {len(written)} files to {out_dir}")
    for path in sorted(written):
        print(path.name)
    if not written:
        raise SystemExit("no units written")
    if args.install:
        install_units(out_dir)
    if skipped:
        raise SystemExit(f"skipped {len(skipped)} jobs: {', '.join(skipped)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
