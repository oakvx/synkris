<?php
declare(strict_types=1);
require __DIR__ . '/../deploy/license-guard.php';
require __DIR__ . '/../deploy/session.php';
if (!extension_loaded('sodium')) throw new RuntimeException('Native PHP with sodium is required for license tests.');
function expect_rejected(callable $fn, string $name): void {
    try { $fn(); } catch (Throwable) { return; }
    throw new RuntimeException('Unexpected acceptance: ' . $name);
}
function b64url(string $bytes): string { return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '='); }
$pair = sodium_crypto_sign_keypair();
$private = sodium_crypto_sign_secretkey($pair);
$public = sodium_crypto_sign_publickey($pair);
$pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode(hex2bin('302a300506032b6570032100') . $public), 64, "\n") . "-----END PUBLIC KEY-----";
$now = 1794132000000;
$payload = ['version'=>1, 'customer'=>'Fixture sintetica', 'plan'=>'test', 'hwid'=>'HW-TEST', 'expiry'=>$now+3600000, 'issuedAt'=>$now-1000, 'graceDays'=>0];
$sign = static function(array $value) use ($private): string {
    $bytes = json_encode($value, JSON_THROW_ON_ERROR);
    return 'LIC=' . b64url($bytes) . "\nSIG=" . b64url(sodium_crypto_sign_detached($bytes, $private)) . "\n";
};
$text = $sign($payload);
if (synkris_verify_license_text($text, $pem, 'HW-TEST', $now)['customer'] !== 'Fixture sintetica') throw new RuntimeException('Valid signature rejected.');
if (synkris_verify_license_text("\xEF\xBB\xBF" . str_replace("\n", "\r\n", $text), $pem, 'HW-TEST', $now)['hwid'] !== 'HW-TEST') throw new RuntimeException('BOM/CRLF rejected.');
expect_rejected(fn()=>synkris_verify_license_text($text, $pem, 'OTHER', $now), 'wrong HWID');
expect_rejected(fn()=>synkris_verify_license_text($text, $pem, '', $now), 'missing HWID');
expect_rejected(fn()=>synkris_verify_license_text($text, $pem, 'HW-TEST', $now+7200000), 'expired');
expect_rejected(fn()=>synkris_verify_license_text($sign([...$payload,'issuedAt'=>$now+600000]), $pem, 'HW-TEST', $now), 'future issue');
expect_rejected(fn()=>synkris_verify_license_text(str_replace('LIC=', 'LIC=A', $text), $pem, 'HW-TEST', $now), 'tampered JSON');
expect_rejected(fn()=>synkris_verify_license_text($text . $text, $pem, 'HW-TEST', $now), 'duplicate fields');
expect_rejected(fn()=>synkris_verify_license_text('LIC=***' . "\nSIG=***", $pem, 'HW-TEST', $now), 'bad base64');
expect_rejected(fn()=>synkris_verify_license_text($text, str_replace('PUBLIC KEY', 'RSA PUBLIC KEY', $pem), 'HW-TEST', $now), 'wrong key type');
expect_rejected(fn()=>synkris_verify_license_text(str_repeat('x',65537), $pem, 'HW-TEST', $now), 'oversize');
expect_rejected(fn()=>synkris_verify_license_text($sign([...$payload,'version'=>2]), $pem, 'HW-TEST', $now), 'unknown version');
$grace = $sign([...$payload,'expiry'=>$now-1000,'graceDays'=>1]);
synkris_verify_license_text($grace,$pem,'HW-TEST',$now);
$_SERVER['REMOTE_ADDR'] = 'unit-' . bin2hex(random_bytes(10));
$limiterFile = sys_get_temp_dir() . '/synk-login-' . hash('sha256', $_SERVER['REMOTE_ADDR']) . '.json';
try {
    for ($i=0;$i<5;$i++) { if (!synk_login_allowed()) throw new RuntimeException('Premature rate limit'); synk_login_allowed(true); }
    if (synk_login_allowed()) throw new RuntimeException('Rate limiter accepted sixth attempt');
    $_SESSION = []; // Cookie/session reset must not reset the address counter.
    if (synk_login_allowed()) throw new RuntimeException('Rate limiter can be bypassed with a new session');
} finally { if (is_file($limiterFile)) unlink($limiterFile); }
sodium_memzero($private);
echo "PASS: 15 PHP license/login security checks\n";
