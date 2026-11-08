<?php
declare(strict_types=1);

function synkris_b64url(string $value): string {
    if ($value === '' || !preg_match('/^[A-Za-z0-9_-]+={0,2}$/D', $value)) throw new RuntimeException('license_encoding_invalid');
    $decoded = base64_decode(strtr($value, '-_', '+/'), true);
    if ($decoded === false) throw new RuntimeException('license_encoding_invalid');
    return $decoded;
}

/** Verify the exact signed JSON bytes, using the same Ed25519 format as Node. */
function synkris_verify_license_text(string $text, string $publicPem, string $hwid, ?int $nowMs = null): array {
    if (!function_exists('sodium_crypto_sign_verify_detached')) throw new RuntimeException('sodium_required');
    if (strlen($text) > 65536) throw new RuntimeException('license_too_large');
    $parts = [];
    foreach (preg_split('/\r?\n/', ltrim($text, "\xEF\xBB\xBF")) as $line) {
        if (preg_match('/^(LIC|SIG)\s*[:=]\s*(\S+)$/D', trim($line), $m)) {
            if (isset($parts[$m[1]])) throw new RuntimeException('license_duplicate_field');
            $parts[$m[1]] = $m[2];
        }
    }
    $bytes = synkris_b64url($parts['LIC'] ?? '');
    $signature = synkris_b64url($parts['SIG'] ?? '');
    $pem = str_replace('\\n', "\n", trim($publicPem));
    if (!preg_match('/\A-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+\/\s=]+)-----END PUBLIC KEY-----\z/D', $pem, $m)) throw new RuntimeException('public_key_invalid');
    $der = base64_decode(preg_replace('/\s+/', '', $m[1]), true);
    $prefix = hex2bin('302a300506032b6570032100');
    if ($der === false || strlen($der) !== 44 || !str_starts_with($der, $prefix) || strlen($signature) !== 64) throw new RuntimeException('public_key_or_signature_invalid');
    if (!sodium_crypto_sign_verify_detached($signature, $bytes, substr($der, 12))) throw new RuntimeException('license_signature_invalid');
    $payload = json_decode($bytes, true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($payload) || ($payload['version'] ?? $payload['v'] ?? 1) !== 1 || empty($payload['customer'] ?? $payload['client'] ?? null) || empty($payload['plan']) || empty($payload['hwid'])) throw new RuntimeException('license_fields_invalid');
    if ($hwid === '' || !is_string($payload['hwid']) || !hash_equals($hwid, $payload['hwid'])) throw new RuntimeException('license_hwid_mismatch');
    $parseTime = static function(mixed $value): float {
        if (is_numeric($value)) return (float)$value;
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}T/', $value)) throw new RuntimeException('license_date_invalid');
        try { return (float)(new DateTimeImmutable($value))->format('U.u') * 1000; }
        catch (Exception) { throw new RuntimeException('license_date_invalid'); }
    };
    $expiry = $parseTime($payload['expiry'] ?? $payload['expiryAt'] ?? $payload['exp'] ?? null);
    $now = $nowMs ?? (int)floor(microtime(true) * 1000);
    $grace = isset($payload['graceDays']) && is_numeric($payload['graceDays']) ? max(0, (float)$payload['graceDays']) : 7;
    if (!is_finite($expiry) || !is_finite($grace) || $now > $expiry + $grace * 86400000) throw new RuntimeException('license_expired');
    $issued = $payload['issuedAt'] ?? $payload['issueAt'] ?? $payload['iat'] ?? null;
    if ($issued !== null && $parseTime($issued) > $now + 300000) throw new RuntimeException('license_issued_in_future');
    return $payload;
}

function synkris_assert_license(): array {
    try {
        $file = (string)(getenv('LICENSE_FILE') ?: '/run/secrets/license.txt');
        $keyFile = (string)(getenv('LICENSE_PUBLIC_KEY_FILE') ?: '/run/secrets/license-public.pem');
        $key = (string)(getenv('LICENSE_PUBLIC_KEY_PEM') ?: '');
        if (!is_file($file) || filesize($file) > 65536) throw new RuntimeException('license_missing');
        if ($key === '') {
            if (!is_file($keyFile) || filesize($keyFile) > 8192) throw new RuntimeException('license_key_missing');
            $key = (string)file_get_contents($keyFile);
        }
        return synkris_verify_license_text((string)file_get_contents($file), $key, (string)(getenv('HWID') ?: getenv('APP_HWID') ?: ''));
    } catch (Throwable) {
        http_response_code(403);
        header('Content-Type: application/json; charset=utf-8');
        exit('{"error":"license_invalid_contact_technician"}');
    }
}
