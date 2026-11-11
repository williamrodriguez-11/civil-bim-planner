"""Assign pre-account projects to a verified user from the server console."""

import argparse

from .db import connect, initialize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("username")
    args = parser.parse_args()
    initialize()
    with connect(True) as db:
        user = db.execute(
            "SELECT id FROM account WHERE username=?", (args.username.strip().lower(),)
        ).fetchone()
        if not user:
            parser.error("Primero crea esa cuenta en la aplicación.")
        updated = db.execute(
            "UPDATE project SET owner=? WHERE owner IS NULL", (user["id"],)
        )
        print(f"Proyectos anteriores asignados: {updated.rowcount}")


if __name__ == "__main__":
    main()
