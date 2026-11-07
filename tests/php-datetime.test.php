<?php
declare(strict_types=1);
function env(string $key, ?string $default=null): ?string { return $key==='TZ' ? 'Europe/Rome' : $default; }
require __DIR__.'/../dashboard/api/datetime.php';
$cases=[
 ['2026-01-15T09:30','2026-01-15T09:30:00+01:00'],
 ['2026-07-15T09:30','2026-07-15T09:30:00+02:00'],
 ['2026-10-26T00:30','2026-10-26T00:30:00+01:00'],
 ['2026-07-15T09:30:00+02:00','2026-07-15T09:30:00+02:00'],
];
foreach($cases as [$input,$expect]) {
  $actual=synk_parse_appointment_datetime($input)->format('Y-m-d\TH:i:sP');
  if($actual!==$expect)throw new RuntimeException("$input => $actual instead of $expect");
}
foreach(['2026-03-29T02:30','2026-10-25T02:30','2026-02-30T12:00','today','2026-07-15T25:00'] as $input){
  try { synk_parse_appointment_datetime($input);throw new RuntimeException("Accepted $input"); }
  catch(InvalidArgumentException $e) { /* expected */ }
}
$summer=synk_parse_appointment_datetime('2026-07-15T09:30');
if($summer->setTimezone(new DateTimeZone('UTC'))->format('H:i')!=='07:30')throw new RuntimeException('Summer timezone conversion incorrect');
echo "PASS: 10 PHP appointment timezone cases\n";
