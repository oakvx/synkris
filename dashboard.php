<?php
// Unico punto di accesso PHP, usato da Apache come router HTTP.
declare(strict_types=1);
require_once __DIR__ . '/deploy/session.php';
synk_session_start();synk_check_origin();
$expected=(string)(getenv('DASHBOARD_PASSWORD')?:'');
if (strlen($expected)<12) {http_response_code(503);exit('Password dashboard non configurata. Contatta il tecnico.');}
if (($_GET['logout']??'')==='1') {$_SESSION=[];session_destroy();header('Location: /');exit;}
if (!synk_logged_in()) {
  $failed=false;
  if ($_SERVER['REQUEST_METHOD']==='POST') {
    $tries=(int)($_SESSION['tries']??0);
    $first=(int)($_SESSION['first_try']??time());
    if (time()-$first>600){$tries=0;$first=time();}
    if ($tries<5 && hash_equals($expected,(string)($_POST['password']??''))) {
      session_regenerate_id(true);$_SESSION['auth']=true;$_SESSION['tries']=0;
      header('Location: /');exit;
    }
    $_SESSION['tries']=$tries+1;$_SESSION['first_try']=$first;$failed=true;
  }
  synk_login_page($failed);
}
require_once __DIR__ . '/dashboard/api/bootstrap.php';
require_once __DIR__ . '/dashboard/api/queries.php';
require_once __DIR__ . '/dashboard/api/mutations.php';
require_once __DIR__ . '/dashboard/api/calendar-outbox.php';
require_once __DIR__ . '/dashboard/api/router.php';
