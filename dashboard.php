<?php
// Authenticated entry point. API writes require the session CSRF token.
declare(strict_types=1);
require_once __DIR__ . '/deploy/session.php';
synk_session_start();
synk_check_origin();
$expected = (string)(getenv('DASHBOARD_PASSWORD') ?: '');
if (strlen($expected) < 12 || str_starts_with($expected, 'SOSTITUISCI')) {
    http_response_code(503); exit('Password dashboard non configurata. Contatta il tecnico.');
}
if (($_GET['logout'] ?? '') === '1') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') { http_response_code(405); exit; }
    $_SESSION = [];
    session_destroy();
    setcookie(session_name(), '', ['expires'=>time()-3600, 'path'=>'/', 'httponly'=>true, 'samesite'=>'Strict']);
    header('Location: /', true, 303); exit;
}
if (!synk_logged_in()) {
    if (isset($_GET['route'])) { http_response_code(401); header('Content-Type: application/json'); exit('{"error":"login_required"}'); }
    $failed = false;
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        if (synk_login_allowed() && is_string($_POST['password'] ?? null) && hash_equals($expected, $_POST['password'])) {
            session_regenerate_id(true);
            $_SESSION['auth'] = true;
            $_SESSION['created_at'] = time();
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
            header('Location: /', true, 303); exit;
        }
        synk_login_allowed(true);
        http_response_code(401);
        $failed = true;
    }
    synk_login_page($failed);
}
require_once __DIR__ . '/dashboard/api/bootstrap.php';
require_once __DIR__ . '/dashboard/api/queries.php';
require_once __DIR__ . '/dashboard/api/mutations.php';
require_once __DIR__ . '/dashboard/api/calendar-outbox.php';
require_once __DIR__ . '/dashboard/api/router.php';
