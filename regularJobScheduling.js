const cron = require("node-cron");

/*
second	0-59
minute	0-59
hour	0-23
day of month	1-31
month	1-12
day of week	0-6 (0 is sunday)
*/

//Every day:
cron.schedule("0 0 0 * * *", function() {
	require('child_process').fork('custom_modules/updateDataFiles.js');
});

cron.schedule("0 0 12 * * *", function() {
	require('child_process').fork('custom_modules/dailyEmails.js');
});

//Every month
cron.schedule("0 0 6 2 * *", function() {
	require('child_process').fork('custom_modules/createBackups.js');
});
