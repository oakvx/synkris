<?php
// Router for the native-PHP integration harness only; never shipped in the ZIP.
declare(strict_types=1);
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/') { require dirname(__DIR__, 2) . '/dashboard.php'; return true; }
if ($path === '/bridge.php') { require dirname(__DIR__, 2) . '/bridge.php'; return true; }
http_response_code(404);
return true;
