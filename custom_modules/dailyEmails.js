"use strict";

const sqlite = require("sqlite3").verbose(),
			fs = require("fs"),
			util = require("util"),
			nodemailer = require("nodemailer"),
			transporter = nodemailer.createTransport(JSON.parse(fs.readFileSync("emailCredentials.json", "utf8"))),
			handleError = require("./handleError.js"),
			getUnfinishedQuestion = require("./getUnfinishedQuestion.js");

/*
const handleEmails = function(peopleToEmail) {
	const db = new sqlite.Database("questionDatabase.db", async function(err) {
		if (err) {
			handleError(err);
		} else {
			const promisifiedAll = util.promisify(db.all),
						dbAll = async function(arg1, arg2) {
							const result = await promisifiedAll.call(db, arg1, arg2);
							return result;
						};

			let allQuestions = await dbAll(`SELECT * FROM questions`);

			for (let i in peopleToEmail) {

				const result = getUnfinishedQuestion(peopleToEmail[i], allQuestions);

				if (result === false) {
					transporter.sendMail({
						from: "admin@rulesguru.net",
						to: peopleToEmail[i].emailAddress,
						subject: "There are no RulesGuru questions needing your attention today!",
						text: `Hi ${peopleToEmail[i].name.split(" ")[0]},\n\nThanks to your help, we've approved the entire database of unfinished questions that need your attention, and there is currently nothing for you to do. I'm sure this will change soon as more questions get submitted. In the mean time, take a while to relax and look over the following images.\n\nhttps://www.google.com/search?tbm=isch&q=cute+bunny+pictures`
					}, function(err) {
						if (err) {
							handleError(err);
						} else {
							console.log(`Successfully sent email to ${peopleToEmail[i].name}`);
						}
					});
				} else {

					transporter.sendMail({
						from: "admin@rulesguru.net",
						to: peopleToEmail[i].emailAddress,
						subject: `Your RulesGuru question to approve`,
						text: `Hi ${peopleToEmail[i].name.split(" ")[0]},\n\nYour question today is #${result.id}. Head on over to https://rulesguru.net/question-editor/?${result.id} and check it out!`
					}, function(err) {
						if (err) {
							handleError(err);
						} else {
							console.log(`Successfully sent email to ${peopleToEmail[i].name}`);
						}
					});

				}
			}
		};
	});
}

try {
	const allAdmins = JSON.parse(fs.readFileSync("admins.json", "utf8"));
	const peopleToEmail = [];
	for (let i in allAdmins) {
		let sendEmail = false;
		switch (allAdmins[i].reminderEmailFrequency) {
			case "Never":
				break;
			case "Daily":
				sendEmail = true;
				break;
			case "Daily except weekends":
				if ([1, 2, 3, 4, 5].includes(new Date().getDay())) {
					sendEmail = true;
				}
				break;
			case "Every two days":
				if (Math.floor(Date.now() / 86400000) % 2 === 0) {
					sendEmail = true;
				}
				break;
			case "Every three days":
				if (Math.floor(Date.now() / 86400000) % 3 === 0) {
					sendEmail = true;
				}
				break;
			case "Every Sunday and Tuesday":
				if ([0, 2].includes(new Date().getDay())) {
					sendEmail = true;
				}
				break;
			case "Every Tuesday and Friday":
				if ([2, 5].includes(new Date().getDay())) {
					sendEmail = true;
				}
				break;
			case "Weekly":
				if (new Date().getDay() === 0) {
					sendEmail = true;
				}
				break;
		}
		if (sendEmail) {
			peopleToEmail.push(allAdmins[i]);
		}
	}
  handleEmails(peopleToEmail);
} catch (err) {
	handleError(err)
}
*/
//Check disk space since the backups tend to get big.
const checkDiskSpace = require("check-disk-space").default;
const fastFolderSize = require("fast-folder-size/sync");
const sendEmailToOwners = function(subject, message) {
	const allAdmins = JSON.parse(fs.readFileSync("admins.json", "utf8"));
	for (let i in allAdmins) {
		if (allAdmins[i].roles.owner) {
			transporter.sendMail({
				"from": "admin@rulesguru.net",
				"to": allAdmins[i].emailAddress,
				"subject": subject,
				"text": message
			}, function(err) {
				if (err) {
					handleError(err);
				}
			});
		}
	}
}
const fileSystemStuff = async function() {
	const diskSpace = await checkDiskSpace("/");
	if (diskSpace.free < 1000000000) {
		sendEmailToOwners("RulesGuru disk space running low", `Only ${diskSpace.free} bytes remaining.`);
	}

	const backupSize = fastFolderSize("backups");
	if (backupSize > 10000000000) {
		sendEmailToOwners("RulesGuru backups folder too large", `The backups folder has grown larger than 10gb on disk, should be pruned.`);
	}
};
fileSystemStuff();