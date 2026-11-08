<?php
declare(strict_types=1);
require __DIR__ . '/../deploy/session.php';
$_SERVER['REMOTE_ADDR'] = 'unit-' . bin2hex(random_bytes(10));
$limiterFile = sys_get_temp_dir() . '/synk-login-' . hash('sha256', $_SERVER['REMOTE_ADDR']) . '.json';
try {
    for ($i=0;$i<5;$i++) { if (!synk_login_allowed()) throw new RuntimeException('Premature rate limit'); synk_login_allowed(true); }
    if (synk_login_allowed()) throw new RuntimeException('Rate limiter accepted sixth attempt');
    $_SESSION = []; // Cookie/session reset must not reset the address counter.
    if (synk_login_allowed()) throw new RuntimeException('Rate limiter can be bypassed with a new session');
} finally { if (is_file($limiterFile)) unlink($limiterFile); }
echo "PASS: PHP login limiter, sixth-attempt block and session-reset resistance\n";
