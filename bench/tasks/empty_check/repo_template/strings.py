def is_blank(s: str) -> bool:
    # BUG: only checks the empty string, not whitespace-only strings.
    return s == ""


def is_present(s: str) -> bool:
    return not is_blank(s)
