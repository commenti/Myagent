#!/data/data/com.termux/files/usr/bin/bash

# agent-cli: automatic file watcher + verification runner for Termux.
# Does NOT delete or rewrite existing project files.

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR" || exit 1

WATCH_DELAY="${WATCH_DELAY:-0.8}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

info()  { printf "%b\n" "${BLUE}[WATCH]${RESET} $*"; }
ok()    { printf "%b\n" "${GREEN}[PASS]${RESET} $*"; }
warn()  { printf "%b\n" "${YELLOW}[WARN]${RESET} $*"; }
error() { printf "%b\n" "${RED}[FAIL]${RESET} $*"; }

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        error "Required command not found: $1"
        return 1
    }
}

has_npm_script() {
    local script="$1"
    [ -f "$PROJECT_DIR/package.json" ] || return 1
    node -e '
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      process.exit(pkg.scripts && pkg.scripts[process.argv[1]] ? 0 : 1);
    ' "$script" >/dev/null 2>&1
}

run_npm_script() {
    local script="$1"
    if has_npm_script "$script"; then
        info "Running npm $script ..."
        if npm run "$script"; then
            ok "npm $script"
            return 0
        else
            error "npm $script failed"
            return 1
        fi
    fi
    return 0
}

check_typescript_project() {
    [ -f "$PROJECT_DIR/tsconfig.json" ] || return 0

    if [ -x "$PROJECT_DIR/node_modules/.bin/tsc" ]; then
        info "TypeScript check: project"
        if "$PROJECT_DIR/node_modules/.bin/tsc" --noEmit --pretty false; then
            ok "TypeScript project check"
            return 0
        fi
        error "TypeScript project check failed"
        return 1
    fi

    if command -v tsc >/dev/null 2>&1; then
        info "TypeScript check: project (global tsc)"
        if tsc --noEmit --pretty false; then
            ok "TypeScript project check"
            return 0
        fi
        error "TypeScript project check failed"
        return 1
    fi

    warn "tsc not found; install a compatible TypeScript version before relying on TS verification."
    return 2
}

check_file() {
    local file="$1"
    local ext="${file##*.}"

    case "$ext" in
        ts|tsx)
            check_typescript_project
            return $?
            ;;
        js|mjs|cjs)
            info "JavaScript syntax check: $file"
            if node --check "$file"; then
                ok "JavaScript syntax: $file"
                return 0
            fi
            error "JavaScript syntax error: $file"
            return 1
            ;;
        json)
            info "JSON validation: $file"
            if node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"));' "$file"; then
                ok "JSON valid: $file"
                return 0
            fi
            error "Invalid JSON: $file"
            return 1
            ;;
        sh|bash)
            info "Shell syntax check: $file"
            if bash -n "$file"; then
                ok "Shell syntax: $file"
                return 0
            fi
            error "Shell syntax error: $file"
            return 1
            ;;
        html|htm|css|md|mdx|txt)
            info "Changed: $file (no dedicated compiler configured)"
            return 0
            ;;
        *)
            info "Changed: $file (no checker configured)"
            return 0
            ;;
    esac
}

run_project_checks() {
    local had_error=0

    # Prefer project-defined checks when they exist.
    if has_npm_script "typecheck"; then
        if ! run_npm_script "typecheck"; then
            had_error=1
        fi
    fi

    if has_npm_script "lint"; then
        if ! run_npm_script "lint"; then
            had_error=1
        fi
    fi

    if has_npm_script "test"; then
        if ! run_npm_script "test"; then
            had_error=1
        fi
    fi

    if has_npm_script "build"; then
        if ! run_npm_script "build"; then
            had_error=1
        fi
    fi

    # When there is no explicit typecheck script, use tsconfig directly.
    if [ -f "$PROJECT_DIR/tsconfig.json" ] && ! has_npm_script "typecheck"; then
        if ! check_typescript_project; then
            had_error=1
        fi
    fi

    if [ -d "$PROJECT_DIR/.git" ] && command -v git >/dev/null 2>&1; then
        info "Git whitespace check"
        if git diff --check -- .; then
            ok "Git diff check"
        else
            error "Git diff check failed"
            had_error=1
        fi
    fi

    return "$had_error"
}

verify_changed_file() {
    local file="$1"
    local event="$2"
    local result=0

    printf "\n"
    info "Detected $event: $file"

    # Deleted files cannot be checked directly; validate project integrity instead.
    if [ "$event" = "DELETE" ] || [ ! -f "$file" ]; then
        warn "File no longer exists; checking project integrity."
        run_project_checks || result=1
    else
        check_file "$file" || result=1

        # Source/config changes can affect other files, so run project-level checks.
        case "${file##*.}" in
            ts|tsx|js|mjs|cjs|json)
                run_project_checks || result=1
                ;;
        esac
    fi

    if [ "$result" -eq 0 ]; then
        ok "Verification complete: $file"
    else
        error "Verification FAILED: $file"
        printf "%b\n\n" "${RED}Fix the reported error before continuing.${RESET}"
    fi
}

main() {
    require_command inotifywait || {
        printf '\nInstall it in Termux with:\n  pkg update && pkg install inotify-tools\n\n'
        exit 1
    }
    require_command node || {
        printf '\nInstall Node.js in Termux with:\n  pkg install nodejs-lts\n\n'
        exit 1
    }
    require_command npm || {
        printf '\nnpm is required. Install Node.js LTS in Termux first.\n'
        exit 1
    }

    if [ ! -f "$PROJECT_DIR/package.json" ]; then
        warn "package.json not found. File-level checks will still work."
    fi

    printf '%b\n' "${GREEN}==============================================${RESET}"
    printf '%b\n' "${GREEN} agent-cli automatic watcher + tester${RESET}"
    printf '%b\n' "${GREEN} Project: $PROJECT_DIR${RESET}"
    printf '%b\n' "${GREEN} Press Ctrl+C to stop${RESET}"
    printf '%b\n' "${GREEN}==============================================${RESET}"

    # close_write catches normal saves; moved_to catches editor temp-file replacement;
    # create catches genuinely new files; delete lets us re-check project integrity.
    inotifywait -m -r \
        -e close_write,create,moved_to,delete \
        --format '%e|%w%f' \
        --exclude '(^|/)(node_modules|\.git|\.agent-runtime|\.cache|dist|build|coverage)(/|$)' \
        "$PROJECT_DIR" |
    while IFS='|' read -r events file; do
        # Ignore this watcher script changing only because of metadata/access noise.
        [ -n "$file" ] || continue

        case "$events" in
            *ISDIR*) continue ;;
        esac

        case "$file" in
            "$PROJECT_DIR/.git/"*) continue ;;
            "$PROJECT_DIR/node_modules/"*) continue ;;
        esac

        # Small debounce: editors often emit several events for one save.
        sleep "$WATCH_DELAY"

        event="CHANGE"
        case "$events" in
            *DELETE*) event="DELETE" ;;
            *CREATE*) event="CREATE" ;;
            *MOVED_TO*) event="MOVED_TO" ;;
            *CLOSE_WRITE*) event="MODIFY" ;;
        esac

        verify_changed_file "$file" "$event"
    done
}

main "$@"
