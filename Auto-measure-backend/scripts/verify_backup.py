#!/usr/bin/env python3
import sqlite3
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: verify_backup.py BACKUP_FILE", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.suffix == ".dump":
        subprocess.run(["pg_restore", "--list", str(path)], check=True, stdout=subprocess.DEVNULL)
    else:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            result = conn.execute("PRAGMA integrity_check").fetchone()
            if not result or str(result[0]).lower() != "ok":
                raise RuntimeError("Backup integrity check failed.")
            required = {"organizations", "users", "shared_projects", "takeoff_requests"}
            present = {
                str(row[0])
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            missing = required - present
            if missing:
                raise RuntimeError(f"Backup is missing required tables: {sorted(missing)}")
    print(f"Backup verified: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
