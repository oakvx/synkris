<?php
declare(strict_types=1);
require_once __DIR__ . '/deploy/session.php';
synk_require_login(); synk_check_origin();
header('Content-Type: application/json; charset=utf-8');
$path = $_GET['path'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!is_string($path) || strlen($path) > 1000 || !str_starts_with($path, '/') || str_contains($path, '//') || preg_match('~[\x00-\x20\\\\]~', $path)) { http_response_code(400); exit('{"error":"invalid_path"}'); }
$routes = [
    '/status'=>['GET'], '/diagnostics'=>['GET'], '/api/onboarding'=>['GET'], '/api/session/qr'=>['GET'], '/api/analytics'=>['GET'],
    '/api/settings'=>['GET','PUT'], '/api/operations'=>['GET'], '/api/chats'=>['GET'], '/api/messages'=>['GET'],
    '/api/handoff'=>['POST'], '/api/send'=>['POST'], '/api/chats/delete'=>['POST'], '/api/ai'=>['GET'],
    '/api/backups'=>['GET'], '/api/backups/download'=>['GET'], '/api/privacy/request/review'=>['POST'],
    '/api/waitlist/opt-in'=>['POST'], '/api/waitlist/withdraw'=>['POST'], '/api/waitlist/options'=>['GET'],
    '/api/schedule'=>['GET','PUT'], '/api/client'=>['GET'], '/api/client/note'=>['PUT'],
    '/api/absences'=>['GET','POST'], '/api/absences/delete'=>['POST'], '/api/clients/search'=>['GET'],
];
$parts = parse_url($path);
if ($parts === false || array_diff(array_keys($parts), ['path','query'])) { http_response_code(400); exit('{"error":"invalid_path"}'); }
$clean = $parts['path'] ?? '';
if (!isset($routes[$clean])) { http_response_code(404); exit('{"error":"not_found"}'); }
if (!in_array($method, $routes[$clean], true)) { http_response_code(405); exit('{"error":"method_not_allowed"}'); }
if ($method !== 'GET' && strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') { http_response_code(415); exit('{"error":"json_required"}'); }
$body = file_get_contents('php://input', false, null, 0, 50001);
if ($body === false || strlen($body) > 50000) { http_response_code(413); exit('{"error":"body_too_large"}'); }
$token = (string)(getenv('ADMIN_TOKEN') ?: '');
if (strlen($token) < 32 || !function_exists('curl_init')) { http_response_code(503); exit('{"error":"bridge_not_configured"}'); }
$isDownload = $clean === '/api/backups/download';
$name = '';
if ($isDownload) {
    parse_str($parts['query'] ?? '', $query);
    $name = $query['name'] ?? '';
    if (!is_string($name) || !preg_match('/^synk-\d{8}-\d{6}\.dump$/D', $name)) { http_response_code(400); exit('{"error":"invalid_backup_name"}'); }
}
$server = rtrim((string)(getenv('BOT_API_INTERNAL') ?: 'http://bot:3000'), '/');
$ch = curl_init($server . $path);
$options = [CURLOPT_RETURNTRANSFER=>!$isDownload, CURLOPT_CONNECTTIMEOUT=>3, CURLOPT_TIMEOUT=>$isDownload ? 3600 : 20,
    CURLOPT_CUSTOMREQUEST=>$method, CURLOPT_FOLLOWLOCATION=>false, CURLOPT_PROTOCOLS=>CURLPROTO_HTTP | CURLPROTO_HTTPS,
    CURLOPT_HTTPHEADER=>['X-Admin-Token: ' . $token, 'Content-Type: application/json']];
if ($method !== 'GET') $options[CURLOPT_POSTFIELDS] = $body;
if ($isDownload) {
    $started = false;
    $options[CURLOPT_WRITEFUNCTION] = static function($curl, string $chunk) use (&$started, $name): int {
        $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
        if (!$started) {
            http_response_code($status >= 100 && $status <= 599 ? $status : 502);
            if ($status === 200) {
                header('Content-Type: application/octet-stream');
                header('Content-Disposition: attachment; filename="' . $name . '"');
            }
            $started = true;
        }
        echo $chunk;
        return strlen($chunk);
    };
}
curl_setopt_array($ch, $options);
// Long upstream calls must not serialize all requests for this browser session.
session_write_close();
$response = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
if ($response === false) {
    if (!headers_sent()) { http_response_code(503); header('Content-Type: application/json'); echo '{"error":"bot_non_disponibile"}'; }
    exit;
}
if ($isDownload) { if (!headers_sent()) http_response_code($status ?: 502); exit; }
http_response_code($status >= 100 && $status <= 599 ? $status : 502);
echo $response;
