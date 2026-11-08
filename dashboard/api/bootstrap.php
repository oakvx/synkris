<?php
declare(strict_types=1);
require_once __DIR__ . '/datetime.php';
ini_set('display_errors', '0');
date_default_timezone_set((string)(getenv('TZ') ?: 'Europe/Rome'));

function env(string $key, ?string $default = null): ?string {
    $value = getenv($key);
    return $value === false || $value === '' ? $default : $value;
}

final class SynkHttpError extends RuntimeException {
    public function __construct(public readonly int $status, string $code) { parent::__construct($code); }
}

function json_response(array $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function synk_body(): array {
    if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new SynkHttpError(415, 'json_required');
    $raw = file_get_contents('php://input', false, null, 0, 50001);
    if ($raw === false || strlen($raw) > 50000) throw new SynkHttpError(413, 'body_too_large');
    try { $value = json_decode($raw, true, 32, JSON_THROW_ON_ERROR); }
    catch (JsonException) { throw new SynkHttpError(400, 'invalid_json'); }
    if (!is_array($value) || array_is_list($value)) throw new SynkHttpError(400, 'json_object_required');
    return $value;
}

function synk_db(): PDO {
    static $pdo;
    if ($pdo instanceof PDO) return $pdo;
    $url = parse_url((string)env('DATABASE_URL', ''));
    if ($url === false || !in_array($url['scheme'] ?? '', ['postgres', 'postgresql'], true) || empty($url['host']) || empty($url['path'])) throw new SynkHttpError(503, 'database_not_configured');
    $host = $url['host']; $db = rawurldecode(substr($url['path'], 1));
    if (preg_match('/[;\s]/', $host . $db)) throw new SynkHttpError(503, 'database_configuration_invalid');
    $pdo = new PDO('pgsql:host=' . $host . ';port=' . (int)($url['port'] ?? 5432) . ';dbname=' . $db . ';connect_timeout=3', rawurldecode($url['user'] ?? ''), rawurldecode($url['pass'] ?? ''), [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES=>false, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    $pdo->exec("SET TIME ZONE 'Europe/Rome'");
    $pdo->exec("SET statement_timeout = '25s'");
    $pdo->exec("SET lock_timeout = '3s'");
    return $pdo;
}

function synk_int(mixed $value, string $field, int $min = 1, int $max = 2147483647): int {
    if (filter_var($value, FILTER_VALIDATE_INT) === false || (int)$value < $min || (int)$value > $max) throw new SynkHttpError(422, 'invalid_' . $field);
    return (int)$value;
}
function synk_text(mixed $value, string $field, int $max = 120): string {
    if (!is_string($value) || trim($value) === '' || strlen($value) > $max || preg_match('/[\x00-\x1f]/', $value)) throw new SynkHttpError(422, 'invalid_' . $field);
    return trim($value);
}
function synk_query(PDO $pdo, string $sql, array $params = []): PDOStatement {
    $stmt = $pdo->prepare($sql); $stmt->execute($params); return $stmt;
}
function synk_version(): string {
    $data = json_decode((string)file_get_contents(__DIR__ . '/../../package.json'), true);
    return (string)($data['version'] ?? 'unknown');
}
