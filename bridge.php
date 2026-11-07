<?php
declare(strict_types=1);
require_once __DIR__.'/deploy/session.php';
synk_require_login();synk_check_origin();
require_once __DIR__.'/deploy/license-guard.php';synkris_assert_license();
header('Cache-Control: no-store');header('X-Content-Type-Options: nosniff');
$path = $_GET['path'] ?? '';
$method=$_SERVER['REQUEST_METHOD']??'GET';
if (!is_string($path) || strlen($path)>250 || !str_starts_with($path,'/') || str_contains($path,'//') || preg_match('~[\x00-\x1f]~',$path)) {http_response_code(400);exit;}
// Strict paths: no arbitrary proxy destinations or hostnames from the browser.
$allowed=['/status','/diagnostics','/api/session/qr','/api/analytics','/api/settings',
 '/api/operations','/api/chats','/api/messages','/api/handoff','/api/send',
 '/api/chats/delete','/api/ai','/api/backups','/api/backups/download',
 '/api/privacy/request/review','/api/waitlist/opt-in','/api/waitlist/withdraw','/api/waitlist/options','/api/schedule','/api/client','/api/client/note','/api/absences','/api/absences/delete','/api/clients/search'];
$parts=parse_url($path);
$clean=$parts['path']??'';
if (!in_array($clean,$allowed,true)||!in_array($method,['GET','POST','PUT'],true)) {http_response_code(404);exit;}
if ($method!=='GET' && empty($_SERVER['CONTENT_TYPE']) && ($_SERVER['CONTENT_LENGTH']??0)>0) {http_response_code(415);exit;}
$server=rtrim(getenv('BOT_API_INTERNAL')?:'http://bot:3000','/');
$ch=curl_init($server.$path);
$body=file_get_contents('php://input');
if (strlen($body)>50000) {http_response_code(413);exit;}
$isDownload=$clean==='/api/backups/download';
if ($isDownload && $method!=='GET') {http_response_code(405);exit;}
if ($isDownload) {
  $filename=basename((string)($_GET['filename']??'backup.dump'));
  if (!preg_match('/^synk-\d{8}-\d{6}\.dump$/',$filename)) {http_response_code(400);exit;}
  header('Content-Type:application/octet-stream');
  header('Content-Disposition:attachment; filename="'.$filename.'"');
  header('X-Content-Type-Options:nosniff');
  session_write_close();
}
$options=[CURLOPT_RETURNTRANSFER=>!$isDownload,CURLOPT_CONNECTTIMEOUT=>3,CURLOPT_TIMEOUT=>$isDownload?3600:20,
 CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_FOLLOWLOCATION=>false,
 CURLOPT_HTTPHEADER=>['X-Admin-Token: '.(getenv('ADMIN_TOKEN')?:''),'Content-Type: application/json']];
if ($method!=='GET') $options[CURLOPT_POSTFIELDS]=$body;
if($isDownload) $options[CURLOPT_WRITEFUNCTION]=static function($curl,$chunk) {
  echo $chunk;return strlen($chunk);
};
curl_setopt_array($ch,$options);
$response=curl_exec($ch);$status=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE);
if ($response===false) {curl_close($ch);if(!headers_sent())http_response_code(503);
  exit($isDownload?'':'{"error":"bot_non_disponibile"}');}
curl_close($ch);
if($isDownload)exit;
http_response_code($status>=100&&$status<=599?$status:502);
header('Content-Type: application/json; charset=utf-8');
echo $response;
