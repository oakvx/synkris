<?php
declare(strict_types=1);

function synk_headers(): void {
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function synk_session_start(): void {
    synk_headers();
    if (session_status() === PHP_SESSION_ACTIVE) return;
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.gc_maxlifetime', '1800');
    session_name('synk_session');
    session_set_cookie_params(['lifetime'=>0, 'path'=>'/', 'secure'=>!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off', 'httponly'=>true, 'samesite'=>'Strict']);
    session_start();
    $now = time();
    if (isset($_SESSION['last_seen']) && ($now - (int)$_SESSION['last_seen'] > 1800 || $now - (int)($_SESSION['created_at'] ?? 0) > 28800)) {
        $_SESSION = [];
        session_regenerate_id(true);
    }
    $_SESSION['last_seen'] = $now;
    $_SESSION['created_at'] ??= $now;
    $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
}

function synk_logged_in(): bool { return ($_SESSION['auth'] ?? false) === true; }

function synk_require_login(): void {
    synk_session_start();
    if (!synk_logged_in()) {
        http_response_code(401);
        header('Content-Type: application/json; charset=utf-8');
        exit('{"error":"login_required"}');
    }
}

/** No proxy headers are trusted. Optional origins must be explicit, server-side. */
function synk_check_origin(): void {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
    if ($site === 'cross-site') { http_response_code(403); exit('origin_not_allowed'); }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '') {
        $scheme = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? '';
        $allowed = [$scheme . '://' . $host];
        $configured = (string)(getenv('DASHBOARD_ALLOWED_ORIGINS') ?: '');
        foreach (explode(',', $configured) as $item) if (trim($item) !== '') $allowed[] = trim($item);
        if (!in_array($origin, $allowed, true)) { http_response_code(403); exit('origin_not_allowed'); }
    }
    if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
        $actual = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? $_POST['csrf'] ?? '';
        if (!is_string($actual) || !hash_equals((string)($_SESSION['csrf'] ?? ''), $actual) || $actual === '') {
            http_response_code(403); exit('csrf_invalid');
        }
    }
}

/** Per-address, file-locked login limiter; changing cookies does not reset it. */
function synk_login_allowed(bool $recordFailure = false): bool {
    $address = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $file = sys_get_temp_dir() . '/synk-login-' . hash('sha256', $address) . '.json';
    $handle = fopen($file, 'c+');
    if ($handle === false || !flock($handle, LOCK_EX)) throw new RuntimeException('login_limiter_unavailable');
    try {
        $record = json_decode(stream_get_contents($handle) ?: '{}', true) ?: [];
        $now = time();
        if ($now - (int)($record['since'] ?? 0) > 600) $record = ['since'=>$now, 'count'=>0];
        $allowed = (int)($record['count'] ?? 0) < 5;
        if ($recordFailure) $record['count'] = (int)($record['count'] ?? 0) + 1;
        ftruncate($handle, 0); rewind($handle);
        fwrite($handle, json_encode($record, JSON_THROW_ON_ERROR));
        return $allowed;
    } finally { flock($handle, LOCK_UN); fclose($handle); }
}

function synk_login_page(bool $failed = false): never {
    header('Content-Type: text/html; charset=utf-8');
    $csrf = htmlspecialchars((string)$_SESSION['csrf'], ENT_QUOTES, 'UTF-8');
    $error = $failed ? '<p class="error" role="alert">Accesso non riuscito. Dopo 5 tentativi attendere 10 minuti.</p>' : '';
    echo '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accedi · synk</title><link rel="icon" href="/assets/logo.svg"><link rel="stylesheet" href="/dashboard/assets/app.css"></head><body class="login-page"><main class="login-card"><img src="/assets/logo.svg" alt="" width="48" height="48"><p class="eyebrow">IL TUO SALONE, IN SINTONIA</p><h1>Benvenuta in synk</h1><p>Accedi al pannello locale del salone.</p>' . $error . '<form method="post" action="/"><input type="hidden" name="csrf" value="' . $csrf . '"><label for="password">Password dashboard</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Accedi al salone</button></form><small>Accesso riservato · prerelease di collaudo</small></main></body></html>';
    exit;
}
