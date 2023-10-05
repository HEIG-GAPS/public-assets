<?php
$data = $_POST['data']
$path = $_POST['path']
file_put_contents("/home/tnunez/public-assets/static/pdf/test.pdf", base64_decode($data))
?>