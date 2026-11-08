import {execFileSync} from 'node:child_process';
const php=process.env.PHP_BINARY||'php';
for(const file of ['tests/php-datetime.test.php','tests/php-security.test.php'])execFileSync(php,[file],{stdio:'inherit'});
