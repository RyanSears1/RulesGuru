"use strict";

const express = require("express"),
			app = express(),
			bodyParser = require("body-parser"),
			compression = require("compression"),
			fs = require("fs"),
			util = require("util"),
			sqlite = require("sqlite3").verbose(),
			handleError = require("./handleError.js"),
			getUnfinishedQuestion = require("./getUnfinishedQuestion.js"),
			nodemailer = require("nodemailer"),
			transporter = nodemailer.createTransport(JSON.parse(fs.readFileSync("emailCredentials.json", "utf8")));

app.set('trust proxy', true);

const templateConvert = require("./public_html/globalResources/templateConvert.js"),
			replaceExpressions = require("./public_html/globalResources/replaceExpressions.js"),
			playerNames = JSON.parse(fs.readFileSync("playerNames.json", "utf8"));

let referenceQuestionArray;

//Array randomizer. Shuffles in place.
const shuffle = function(array) {
  let currentIndex = array.length, temporaryValue, randomIndex;
  // While there remain elements to shuffle...
  while (0 !== currentIndex) {

    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    // And swap it with the current element.
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }
}

app.use(compression());
app.use(bodyParser.json({"limit":"1mb"}));
app.use(bodyParser.urlencoded({"extended": true}));
app.use(express.static("./public_html"));

let server;

const sendEmailToOwners = function(subject, message, res) {
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
					if (res) {
						res.send("email error")
					}
				} else {
					if (res) {
						res.send("success")
					}
				}
			});
		}
	}
}

let promisifiedAll,
		promisifiedGet,
		promisifiedRun,
		dbAll,
		dbGet,
		dbRun;

const db = new sqlite.Database("questionDatabase.db", function(err) {
	if (err) {
		handleError(err);
	} else {
		console.log("Database created");

		promisifiedAll = util.promisify(db.all),
		promisifiedGet = util.promisify(db.get),
		promisifiedRun = util.promisify(db.run),
		dbAll = async function(arg1, arg2) {
			const result = await promisifiedAll.call(db, arg1, arg2);
			return result;
		},
		dbGet = async function(arg1, arg2) {
			const result = await promisifiedGet.call(db, arg1, arg2);
			return result;
		},
		dbRun = async function(arg1, arg2) {
			const result = await promisifiedRun.call(db, arg1, arg2);
			return result;
		};

		updateReferenceObjects(true);
	};
});

const validateAdmin = function(password) {
	const allAdmins = JSON.parse(fs.readFileSync("admins.json", "utf8"));
	let currentAdmin;
	for (let i in allAdmins) {
		if (password === allAdmins[i].password) {
			currentAdmin = allAdmins[i];
			break;
		}
	}
	if (!currentAdmin) {
		return "Incorrect password.";
	} else if (!Object.values(currentAdmin.roles).includes(true)) {
		return "Your account is disabled. Please contact the site owner if you think this is in error.";
	} else {
		return JSON.parse(JSON.stringify(currentAdmin));
	}
}

//Format a question to be sent to the browser and send it.
const sendQuestion = function(question, res, allCards) {
	const questionToSend = JSON.parse(JSON.stringify(question));
	questionToSend.oracle = [];
	let chosenCards = [];
	if (questionToSend.cardLists.length > 0) {

		//Randomly pick cards for the question.
		let chosenCards;
		for (let i = 0 ; i < 100000 ; i++) {
			chosenCards = [];
			for (let j = 0 ; j < questionToSend.cardLists.length ; j++) {
				chosenCards.push(questionToSend.cardLists[j][Math.floor(Math.random()*questionToSend.cardLists[j].length)]);
			}
			if (Array.from(new Set(chosenCards)).length === chosenCards.length) {
				break;
			}
		}
		if (Array.from(new Set(chosenCards)).length !== chosenCards.length) {
			res.json({"error":"There are no questions that fit your parameters. Please change your settings and try again.\n\Have a question that would fit those parameters? Submit it!"});
			return;
		}

		for (let i = 0 ; i < chosenCards.length ; i++) {
			questionToSend.oracle.push(allCards[chosenCards[i]]);
		}
	}
	//Don't send the cardLists since they're not needed.
	delete questionToSend.cardLists;

	const allRules = JSON.parse(fs.readFileSync("allRules.json"));
	const allNeededRuleNumbers = (questionToSend.question + questionToSend.answer).match(/(?<=\[)(\d{3}(\.\d{1,3}([a-z])?)?)(?=\])/g) || [];
	const allNeededRules = Object.values(allRules).filter(function(rule) {
		return allNeededRuleNumbers.includes(rule.ruleNumber);
	});

	questionToSend.citedRules = {};
	for (let rule of allNeededRules) {
		questionToSend.citedRules[rule.ruleNumber] = rule;
	}

	res.json(questionToSend);
}

const convertAllTemplates = function(question, allCards) {
	const convertedQuestion = JSON.parse(JSON.stringify(question))
	convertedQuestion.cardLists = [];
	for (let i = 0 ; i < convertedQuestion.cardGenerators.length ; i++) {
		if (typeof convertedQuestion.cardGenerators[i][0] === "object") {
			convertedQuestion.cardLists[i] = templateConvert(convertedQuestion.cardGenerators[i], allCards);
		} else {
			convertedQuestion.cardLists[i] = convertedQuestion.cardGenerators[i]
		}
	}
	delete convertedQuestion.cardGenerators;
	return convertedQuestion;
};

//Update the reference question database and card object that are stored in memory.
const updateReferenceObjects = function(startServer) {

	const allCards = JSON.parse(fs.readFileSync("allCards.json", "utf8"));

	db.all(`SELECT json FROM questions WHERE status = "finished"`, [], function(err, result) {
		if (err) {
			handleError(err);
		} else {
			referenceQuestionArray = result;
			referenceQuestionArray.forEach(function(currentValue, index){
				referenceQuestionArray[index] = JSON.parse(currentValue.json);
			});

			for (let i = 0 ; i < referenceQuestionArray.length ; i++) {
				//Expand templates.
				referenceQuestionArray[i] = convertAllTemplates(referenceQuestionArray[i], allCards);

				//Check for a template that generated 0 cards.
				let emptyTemplate = false;
				for (let j = 0 ; j < referenceQuestionArray[i].cardLists.length ; j++) {
					if (referenceQuestionArray[i].cardLists[j].length === 0) {
						emptyTemplate = true;
					}
				}
				if (emptyTemplate) {
					sendEmailToOwners("RulesGuru template error", `Question ${referenceQuestionArray[i].id} generates an empty template.\n\nhttps://rulesguru.net/question-editor/?${referenceQuestionArray[i].id}`);
				}
			}
			console.log("Reference question array generation complete");
			updateIndexQuestionCount();
			if (startServer) {
				server = app.listen(8080, function () {
					console.log("Listening on port 8080");
				});
			}
		}
	});
}
setInterval(updateReferenceObjects, 86400000, false);

//Modifies the original question to matches the settings specified and returns it, or returns false if it can't match.
const questionMatchesSettings = function(question, settings, allCards) {
	//Move to the next question if level or complexity don't fit.
	if (!settings.level.includes(question.level)) {
		return false;
	}
	if (!settings.complexity.includes(question.complexity)) {
		return false;
	}

	//Move to the next question if the tags don't match.
	if (settings.tags.length > 0) {
		if (settings.tagsConjunc === "OR") {
			if (!(settings.tags.some(function(element) {
				return question.tags.includes(element);
			}))) {
				return false;
			}
		} else if (settings.tagsConjunc === "AND") {
			if (!(settings.tags.every(function(element){
				return question.tags.includes(element);
			}))) {
				return false;
			}
		} else if (settings.tagsConjunc === "NOT") {
			if (settings.tags.some(function(element) {
				return question.tags.includes(element);
			})) {
				return false;
			}
		}
	}
	//Move to the next question if the rules don't match.
	if (settings.rules.length > 0) {
		const citedRules = question.answer.match(/\d{3}(?:\.\d{1,3}(?:[a-z])?)?(?=\])/g) || [];
		const requiredRulesExact = settings.rules.filter(function(currentvalue){
			return currentvalue.endsWith(".");
		});
		requiredRulesExact.forEach(function(currentvalue, index){
			requiredRulesExact[index] = currentvalue.slice(0, currentvalue.length-1);
		});
		const requiredRulesFuzzy = settings.rules.filter(function(currentvalue){
			return !currentvalue.endsWith(".");
		});
		const isCitedExact = function (element) {
			return citedRules.includes(element);
		};
		const isCitedFuzzy = function(element){
			return citedRules.some(function(element2){
				return element2.match(new RegExp(element + "(?=[a-z\.]|$)"));
			});
		};
		if (settings.rulesConjunc === "OR") {
			if (!(requiredRulesExact.some(isCitedExact) || requiredRulesFuzzy.some(isCitedFuzzy))) {
				return false;
			}
		} else if (settings.rulesConjunc === "AND") {
			if (!(requiredRulesExact.every(isCitedExact) && requiredRulesFuzzy.every(isCitedFuzzy))) {
				return false;
			}
		} else if (settings.rulesConjunc === "NOT") {
			if (requiredRulesExact.some(isCitedExact) || requiredRulesFuzzy.some(isCitedFuzzy)) {
				return false;
			}
		}
	}
/*
	/// Remove errored cards and alert me to remove them from the database.
	for (let j = 0 ; j < question.cardLists.length ; j++) {
		for (let k = 0 ; k < question.cardLists[j].length ; k++) {
			if (!allCards[question.cardLists[j][k]]) {
				sendEmailToOwners("RulesGuru question with illegal cards", question.id + "\n" + JSON.stringify(question.cardLists[j][k]));
				question.cardLists[j].splice(k, 1);
				k--;
			}
		}
	}
*/
	//Remove cards that don't match legality (including playable only) and move to the next question if no valid cards are left.
	if (settings.legality === "Choose Expansions") {
		for (let list in question.cardLists) {
			question.cardLists[list] = question.cardLists[list].filter(function(card) {
				return settings.expansions.some(function(expansion) {
					return allCards[card].printingsName.includes(expansion);
				});
			});
		}
	} else if (["Modern", "Pioneer", "Standard"].includes(settings.legality)) {
		for (let list in question.cardLists) {
			question.cardLists[list] = question.cardLists[list].filter(function(card) {
				if (allCards[card]) {//This check is for questions that were submitted with illegal cards.
					if (!allCards[card].legalities[settings.legality[0].toLowerCase() + settings.legality.slice(1)]) {
						 return false;
					} else {
						if (settings.playableOnly) {
							if (allCards[card].playability.includes(settings.legality)) {
								return true;
							} else {
								return false;
							}
						} else {
							return true;
						}
					}
				}
			});
		}
	}
	for (let j = 0 ; j < question.cardLists.length ; j++) {
		if (question.cardLists[j].length === 0) {
			return false;
		}
	}
	//Remove non-matching cards and move to the next question if no valid set of cards is found.
	if (settings.cards.length > 0) {
		if (settings.cardsConjunc === "AND") {
			const requiredCards = settings.cards.slice();
			for (let j = 0 ; j < question.cardLists.length ; j++) {
				for (let k = 0 ; k < question.cardLists[j].length ; k++) {
					if (requiredCards.includes(question.cardLists[j][k])) {
						requiredCards.splice(requiredCards.indexOf(question.cardLists[j][k]), 1);
						question.cardLists[j] = [question.cardLists[j][k]];
						break;
					}
				}
			}
			if (requiredCards.length > 0) {
				return false;
			}
		} else if (settings.cardsConjunc === "OR") {
			const cardListMap = [];
			for (let j = 0 ; j < question.cardLists.length ; j++) {
				cardListMap.push(j);
			}
			shuffle(cardListMap);

			let foundCard = false;
			questionLoop:
			for (let j = 0 ; j < cardListMap.length ; j++) {
				for (let k in settings.cards) {
					if (question.cardLists[cardListMap[j]].includes(settings.cards[k])) {
						question.cardLists[cardListMap[j]] = [settings.cards[k]];
						foundCard = true;
						break questionLoop;
					}
				}
			}
			if (!foundCard) {
				return false;
			}
		} else if (settings.cardsConjunc === "NOT") {
			for (let j = 0 ; j < question.cardLists.length ; j++) {
				question.cardLists[j] = question.cardLists[j].filter(function(card) {
					return !settings.cards.includes(card);
				});
			}
			for (let j = 0 ; j < question.cardLists.length ; j++) {
				if (question.cardLists[j].length === 0) {
					return false;
				}
			}
		}
	}
	return question;
}

const updateIndexQuestionCount = function() {
	let html = fs.readFileSync("public_html/index.html", "utf8");
	html = html.replace(/(?<=\<span id=\"questionCount\"\>)\d+(?=\<\/span\>)/, referenceQuestionArray.length);
	html = html.replace(/(?<=\<span id=\"questionCountMobile\"\>)\d+(?=\<\/span\>)/, referenceQuestionArray.length);
	fs.writeFileSync("public_html/index.html", html);
}

//Returns a random map of player names and genders for each possible player tag.
const getPlayerNamesMap = function() {
	const playerNamesMap = {};
	const genderOrder = ["female", "male", "neutral"];
	shuffle(genderOrder);
	let genderIndex = 0;
	const iterationOrder = ["AP", "NAP1", "NAP2", "NAP3", "NAP"];

	for (let i in iterationOrder) {
		const correctGenderPlayerNames = playerNames[iterationOrder[i]].filter(function(element) {
			return element.gender === genderOrder[genderIndex];
		})
		playerNamesMap[iterationOrder[i]] = correctGenderPlayerNames[Math.floor(Math.random() * correctGenderPlayerNames.length)];
		genderIndex++;
		if (genderIndex > 2) {
			genderIndex = 0;
		}
	}

	shuffle(genderOrder);
	let correctGenderPlayerNames = playerNames.AP.filter(function(element) {
		return element.gender === genderOrder[0];
	})
	playerNamesMap.APa = correctGenderPlayerNames[Math.floor(Math.random() * correctGenderPlayerNames.length)];
	correctGenderPlayerNames = playerNames.AP.filter(function(element) {
		return element.gender === genderOrder[1];
	})
	playerNamesMap.APb = correctGenderPlayerNames[Math.floor(Math.random() * correctGenderPlayerNames.length)];

	shuffle(genderOrder);
	correctGenderPlayerNames = playerNames.NAP.filter(function(element) {
		return element.gender === genderOrder[0];
	})
	playerNamesMap.NAPa = correctGenderPlayerNames[Math.floor(Math.random() * correctGenderPlayerNames.length)];
	correctGenderPlayerNames = playerNames.NAP.filter(function(element) {
		return element.gender === genderOrder[1];
	})
	playerNamesMap.NAPb = correctGenderPlayerNames[Math.floor(Math.random() * correctGenderPlayerNames.length)];

	return playerNamesMap;
}

//Format a question to be sent to the browser and send it.
const sendAPIQuestions = function(questions, res, allCards) {
	const allQuestionsToSend = {
		"status": 200,
		"questions": []
	};
	for (let question of questions) {
		const questionToSend = JSON.parse(JSON.stringify(question));

		let cardExpressions = Array.from((questionToSend.question + " " + questionToSend.answer).matchAll(/\[(card \d+(?::other side)?)(?::(?:colors|mana cost|mana value|supertypes|types|subtypes|power|toughness|loyalty))?(?::simple)?\]/g));
		cardExpressions = cardExpressions.map(result => result[1]);//Use just the capture group.
		cardExpressions = cardExpressions.filter(function(item, pos, self) {//Remove duplicates while preserving order of first instance.
			return self.indexOf(item) == pos;
		});

		const chosenCardNames = [];
		if (questionToSend.cardLists.length > 0) {
			//Randomly pick cards for the question.
			for (let i = 0 ; i < 100000 ; i++) {
				for (let j = 0 ; j < questionToSend.cardLists.length ; j++) {
					chosenCardNames.push(questionToSend.cardLists[j][Math.floor(Math.random()*questionToSend.cardLists[j].length)]);
				}
				if (Array.from(new Set(chosenCardNames)).length === chosenCardNames.length) {
					break;
				}
			}
			if (Array.from(new Set(chosenCardNames)).length !== chosenCardNames.length) {
				res.json({"error":"There are no questions that fit your parameters. Please change your settings and try again.\n\Have a question that would fit those parameters? Submit it!"});
				return;
			}

			questionToSend.includedCards = [];
			for (let i = 0 ; i < cardExpressions.length ; i++) {
				const cardNum = Number(cardExpressions[i].match(/(?<=card )\d+/));
				const isOtherSide = /card \d+:other side/.test(cardExpressions[i]);

				let matchedCard = allCards[chosenCardNames[cardNum - 1]];
				if (isOtherSide) {
					if (matchedCard.side === "a") {
						matchedCard = allCards[matchedCard.names[1]];
					} else {
						matchedCard = allCards[matchedCard.names[0]];
					}
				}

				questionToSend.includedCards.push(matchedCard);
			}
		}
		//Don't send the cardLists since they're not needed.
		delete questionToSend.cardLists;

		//Handle formatting.
		const allRules = JSON.parse(fs.readFileSync("allRules.json"));
		const playerNamesMap = getPlayerNamesMap();

		const chosenCards = chosenCardNames.map(cardName => allCards[cardName]);//We need to provide the cards to replaceExpressions in card generator order, not in text order like they are in includedCards.


		questionToSend.questionSimple = replaceExpressions(questionToSend.question, playerNamesMap, chosenCards, allCards, allRules).plaintext;
		questionToSend.answerSimple = replaceExpressions(questionToSend.answer, playerNamesMap, chosenCards, allCards, allRules).plaintext;
		questionToSend.questionHTML = replaceExpressions(questionToSend.question, playerNamesMap, chosenCards, allCards, allRules).html;
		questionToSend.answerHTML = replaceExpressions(questionToSend.answer, playerNamesMap, chosenCards, allCards, allRules).html;

		//Add citedRules
		const allNeededRuleNumbers = (questionToSend.question + questionToSend.answer).match(/(?<=\[)(\d{3}(\.\d{1,3}([a-z])?)?)(?=\])/g) || [];
		const allNeededRules = Object.values(allRules).filter(function(rule) {
			return allNeededRuleNumbers.includes(rule.ruleNumber);
		});
		questionToSend.citedRules = {};
		for (let rule of allNeededRules) {
			questionToSend.citedRules[rule.ruleNumber] = rule;
		}

		//Remove old raw properties.
		delete questionToSend.question;
		delete questionToSend.answer;

		//Add this question to the array of all questions to send to the client.
		allQuestionsToSend.questions.push(questionToSend);
	}

	res.json(allQuestionsToSend);
}


/*List and description of request endpoints:

Question Editor:

/submitAdminQuestion: Requests from the admin page to submit a new question.
/updateQuestion: Requests from the admin page to update an existing question without changing its status.
/changeQuestionStatus: Requests from the admin page to change the status (and update) a question.
/getUnfinishedQuestion: Requests from the admin page to get a random unfinished question.
/getSpecificAdminQuestion: Requests from the admin page to get a question by its ID.
/getQuestionsList: Requests from the admin page to get a list of all question IDs that match parameters.
/validateLogin: Validates passwords.
/getTagData: Returns an object that lists tag names and counts.
/getAdminData: Admin data
/updateAdminData: update admin data
/updateAndForceStatus: Handle the owner-only options to force a question into a particular status.

General:

/submitContactForm: Contact form.
/getQuestionCount: Requests from the main page for the number of finished questions. Also requests from the editor for unfinished questions.
/submitQuestion: Requests from the submit page to submit an unfinished question.
/logSearchLinkData: Logs followed searchLinks.

API:

/api/questions

Development:

/mostPlayedStandard: Mirror since the origin API is private.
/mostPlayedPioneer: Mirror since the origin API is private.
/mostPlayedModern: Mirror since the origin API is private.

*/

let recentIPs = [];
app.get("/api/questions", function(req, res) {
	let requestSettings;
	try {
		requestSettings = JSON.parse(decodeURIComponent(req.query.json));
	} catch (error) {
		handleError(error);
		res.json({"status": 400, "error":"json parameter is not valid JSON."});
		return;
	}

	//When a request is received, update recentIPs to include only ones from within the last 2 seconds.
	recentIPs = recentIPs.filter(ip => Date.now() - ip.date < 2000);
	if (recentIPs.filter(ip => ip.ip).length > 0 && !requestSettings.avoidRateLimiting) {//If you find this and use it to get around my rate limiting, go ahead, you deserve it. But I'll be fixing this eventally.
		res.json({"status": 429, "error":"Please don't send more than one request every 2 seconds."});
		recentIPs.push({"ip": req.ip, "date": Date.now()});
		return;
	} else {
		recentIPs.push({"ip": req.ip, "date": Date.now()});
	}

	let apiLog = JSON.parse(fs.readFileSync("logs/apiLog.json", "utf8"));
	apiLog.push({"date": Date.now(), "request": req.query, "ip": req.ip});
	fs.writeFileSync("logs/apiLog.json", JSON.stringify(apiLog));

	const allCards = JSON.parse(fs.readFileSync("allCards.json", "utf8"));
	let questionArray = JSON.parse(JSON.stringify(referenceQuestionArray));
	try {
		let defaults;
		if (requestSettings.id === undefined) {
			defaults = {
				"count": 1,
				"level": ["0", "1", "2"],
				"complexity": ["Simple", "Intermediate"],
				"legality": "Modern",
				"expansions": [],
				"playableOnly": false,
				"tags": ["Unsupported answers"],
				"tagsConjunc": "NOT",
				"rules": [],
				"rulesConjunc": "OR",
				"cards": [],
				"cardsConjunc": "OR",
				"previousId": undefined,
				"id": undefined,
			};
			} else {
				defaults = {
					"count": 1,
					"level": ["0", "1", "2", "3", "Corner Case"],
					"complexity": ["Simple", "Intermediate", "Complicated"],
					"legality": "All of Magic",
					"expansions": [],
					"playableOnly": false,
					"tags": [],
					"tagsConjunc": "OR",
					"rules": [],
					"rulesConjunc": "OR",
					"cards": [],
					"cardsConjunc": "OR",
					"previousId": undefined,
					"id": undefined,
				};
			}

			for (let prop in defaults) {
				if (!requestSettings.hasOwnProperty(prop)) {
					requestSettings[prop] = defaults[prop];
				}
			}
	} catch (error) {
		handleError(error);
		res.json({"status": 400, "error":"Incorrectly formatted query string."});
		return;
	}

	try {
		if (requestSettings.id !== undefined) {
			if (typeof requestSettings.id !== "number" || requestSettings.id < 1) {
				res.json({"status": 400, "error":"Invalid ID provided."});
				return;
			}
			let questionToReturn;
			for (let i = 0 ; i < questionArray.length ; i++) {
				if (questionArray[i].id === requestSettings.id) {
					questionToReturn = questionArray[i];
					break;
				}
			}
			if (!questionToReturn) {
				res.json({"status": 404, "error":"A question with that ID does not exist."});
				return;
			}
			const result = questionMatchesSettings(questionToReturn, requestSettings, allCards);
			if (!result) {
				res.json({"status": 400, "error":`Question ${requestSettings.id} cannot match the chosen settings.`});
				return;
			}
			sendAPIQuestions([result], res, allCards);
		} else {
			let locationToStartSearch;
			if (requestSettings.previousId !== undefined) {
				questionArray.sort((a, b) => a.id - b.id);
				for (let i = 0 ; i < questionArray.length ; i++) {
					if (questionArray[i].id > requestSettings.previousId) {
						locationToStartSearch = i;
						break;
					}
				}
				if (locationToStartSearch === undefined) {
					locationToStartSearch = 1;
				}
			} else {
				locationToStartSearch = 1;
				shuffle(questionArray);
			}

			const questionsToReturn = [];
			let currentSearchLocation = locationToStartSearch;
			while (true) {
				const result = questionMatchesSettings(questionArray[currentSearchLocation], requestSettings, allCards);
				if (result) {
					questionsToReturn.push(result);
				}
				if (questionsToReturn.length === requestSettings.count) {
					sendAPIQuestions(questionsToReturn, res, allCards);
					break;
				}
				currentSearchLocation++;
				if (currentSearchLocation === questionArray.length) {
					currentSearchLocation = 1;
				}
				if (currentSearchLocation === locationToStartSearch) {
					res.json({"status": 404, "error":"There are not enough questions that fit your parameters."});
					break;
				}
			}
		}
	} catch (error) {
		console.log(error)
		res.json({"status": 400, "error":"Incorrectly formatted json."});
	}
});

app.post("/submitContactForm", function(req, res) {
	if (req.body.message !== undefined) {
		const message = req.body.message;
		const num = message.match(/^Message about question #(\d+):/)[1];
		sendEmailToOwners(num ? `RulesGuru contact form submission about question ${num}` : "RulesGuru contact form submission", message, res);
		transporter.sendMail({
			"from": "admin@rulesguru.net",
			"to": "admin@rulesguru.net",
			"subject": "RulesGuru contact form submission",
			"text": message,
			"replyTo": req.body.returnEmail
		}, function(err) {
			if (err) {
				handleError(err);
				if (res) {
					res.send("email error")
				}
			} else {
				if (res) {
					res.send("success")
				}
			}
		});
	} else {
		res.send("req.body.message was undefined.");
	}
});

app.get("/getQuestionCount", async function(req, res) {

	const allData = await dbAll(`SELECT * FROM questions`);

	if (referenceQuestionArray.length !== allData.filter(question => question.status === "finished").length) {
		handleError(`Reference question length does not match database. (${referenceQuestionArray.length} vs. ${allData.filter(question => question.status === "finished").length})`);
	}

	allData.forEach(function(question) {
		question.verification = JSON.parse(question.verification);
	});

	res.json({
		"finished": referenceQuestionArray.length,
		"pending": allData.filter(question => question.status === "pending").length,
		"awaitingVerificationGrammar": allData.filter(question => question.status === "awaiting verification" && question.verification.grammarGuru === null).length,
		"awaitingVerificationTemplates": allData.filter(question => question.status === "awaiting verification" && question.verification.templateGuru === null).length,
		"awaitingVerificationRules": allData.filter(question => question.status === "awaiting verification" && question.verification.rulesGuru === null).length,
	});

	let countLog = JSON.parse(fs.readFileSync("logs/questionCountLog.json", "utf8"));
	countLog.push(Date.now());
	fs.writeFileSync("logs/questionCountLog.json", JSON.stringify(countLog));
});

app.post("/submitAdminQuestion", async function(req, res) {
	const date = Date();
	const validateAdminResult = validateAdmin(req.body.password);
	let currentAdmin;
	if (typeof validateAdminResult === "string") {
		res.json({
			"error": true,
			"message": validateAdminResult
		});
	} else {
		currentAdmin = validateAdminResult;
		const addQuestionResult = await addQuestion(req.body.questionObj, true, currentAdmin.id);

		if (!addQuestionResult.error) {

			//Update the reference question array
			if (addQuestionResult.newStatus === "finished") {
				let newQuestion = req.body.questionObj;
				const allCards = JSON.parse(fs.readFileSync("allCards.json", "utf8"));
				newQuestion = convertAllTemplates(newQuestion, allCards);

				//Check for a template that generated 0 cards.
				let emptyTemplate = false;
				for (let j = 0 ; j < newQuestion.cardLists.length ; j++) {
					if (newQuestion.cardLists[j].length === 0) {
						emptyTemplate = true;
					}
				}
				if (emptyTemplate) {
					sendEmailToOwners("RulesGuru template error", `Question ${newQuestion.id} generates an empty template.\n\nhttps://rulesguru.net/question-editor/?${newQuestion.id}`);
				}
				referenceQuestionArray.push(newQuestion);
				updateIndexQuestionCount();
			}

			res.json({
				"error": false,
				"message": `Question #${addQuestionResult.newId} submitted successfully.`,
				"id": addQuestionResult.newId,
				"status": addQuestionResult.newStatus,
				"verification": addQuestionResult.newVerification
			});
			if (currentAdmin.sendSelfEditLogEmails) {
				transporter.sendMail({
					from: "admin@rulesguru.net",
					to: currentAdmin.emailAddress,
					subject: "You submitted a RulesGuru question",
					text: `You submitted question #${addQuestionResult.newId}.\n\nhttps://rulesguru.net/question-editor/?${addQuestionResult.newId}\n\nTime: ${date}\n\n\n${JSON.stringify(req.body.questionObj, null, 2)}`
				}, function(err) {
						if (err) {
							handleError(err);
						}
				});
			}
			if (!currentAdmin.roles.owner) {
				sendEmailToOwners(`RulesGuru admin submission (${currentAdmin.name})`, `${currentAdmin.name} has submitted question #${addQuestionResult.newId}.\n\nhttps://rulesguru.net/question-editor/?${addQuestionResult.newId}\n\nTime: ${date}\n\n\n${JSON.stringify(req.body.questionObj, null, 2)}`);
			}
		} else {
			res.json({
				"error": true,
				"message": `Your question encountered an error being submitted. (${addQuestionResult.error}) Please report this to the site owner.`
			});
		}
	}
});

app.post("/updateQuestion", async function(req, res) {
	const validateAdminResult = validateAdmin(req.body.password);
	let currentAdmin;
	if (typeof validateAdminResult === "string") {
		res.send(validateAdminResult);
	} else {
		currentAdmin = validateAdminResult;
		let error = false;
		if (!(Number.isInteger(req.body.questionObj.id) && req.body.questionObj.id > 0)) {
			res.send("That question doesn't exist.");
			return;
		}
		const date = Date();
		const oldQuestion = await dbGet(`SELECT * FROM questions WHERE id = ${req.body.questionObj.id}`);

		if (oldQuestion) {
			await dbRun(`UPDATE questions SET json = '${JSON.stringify(req.body.questionObj).replace(/'/g,"''")}' WHERE id = ${req.body.questionObj.id}`);
			res.json({
				"message": `Question #${req.body.questionObj.id} updated successfully.`
			});

			//Update the reference question array
			if (oldQuestion.status === "finished") {
				for (let i in referenceQuestionArray) {
					if (referenceQuestionArray[i].id === req.body.questionObj.id) {
						let newQuestion = req.body.questionObj;
						const allCards = JSON.parse(fs.readFileSync("allCards.json", "utf8"));
						newQuestion = convertAllTemplates(newQuestion, allCards);
						//Check for a template that generated 0 cards.
						let emptyTemplate = false;
						for (let j = 0 ; j < newQuestion.cardLists.length ; j++) {
							if (newQuestion.cardLists[j].length === 0) {
								emptyTemplate = true;
							}
						}
						if (emptyTemplate) {
							sendEmailToOwners("RulesGuru template error", `Question ${newQuestion.id} generates an empty template.\n\nhttps://rulesguru.net/question-editor/?${newQuestion.id}`);
						}
						referenceQuestionArray[i] = newQuestion;
					}
				}
			}

			//Send emails about the change.
			if (currentAdmin.sendSelfEditLogEmails) {
				transporter.sendMail({
					from: "admin@rulesguru.net",
					to: currentAdmin.emailAddress,
					subject: `Your RulesGuru admin update`,
					text: `You've updated question #${req.body.questionObj.id} (${oldQuestion.status}).\n\nhttps://rulesguru.net/question-editor/?${req.body.questionObj.id}\n\nTime: ${date}\n\n\nOld question:\n\n${JSON.stringify(JSON.parse(oldQuestion.json), null, 2)}\n\n\nNew question:\n\n${JSON.stringify(req.body.questionObj, null, 2)}`
				}, function(err) {
						if (err) {
							handleError(err);
						}
				});
			}
			if (!currentAdmin.roles.owner) {
				sendEmailToOwners(`RulesGuru admin update (${currentAdmin.name})`, `${currentAdmin.name} has updated question #${req.body.questionObj.id} (${oldQuestion.status}).\n\nhttps://rulesguru.net/question-editor/?${req.body.questionObj.id}\n\nTime: ${date}\n\n\nOld question:\n\n${JSON.stringify(JSON.parse(oldQuestion.json), null, 2)}\n\n\nNew question:\n\n${JSON.stringify(req.body.questionObj, null, 2)}`);
			}
		} else {
			res.json({"message": "That question doesn't exist."});
		}
	}
});

app.post("/changeQuestionStatus", async function(req, res) {
	const validateAdminResult = validateAdmin(req.body.password);
	let currentAdmin;
	if (typeof validateAdminResult === "string") {
		res.json({
			"error": true,
			"message": validateAdminResult
		});
		return;
	} else {
		currentAdmin = validateAdminResult;
		if (!(Number.isInteger(req.body.questionObj.id) && req.body.questionObj.id > 0)) {
			res.json({
				"error": true,
				"message": "That question doesn't exist."
			});
			return;
		}

		//Update the question.
		const statusChange = req.body.statusChange;
		delete req.body.questionObj.approve;
		let date = Date(),
				verificationObject,
				newStatus,
				action = "",
				action2 = "";

		const oldQuestion = await dbGet(`SELECT * FROM questions WHERE id = ${req.body.questionObj.id}`);

		if (!oldQuestion) {
			res.json({
				"error": true,
				"message": "That question doesn't exist."
			});
			return;
		}

		if (statusChange === "increase") {
			if (oldQuestion.status === "pending") {
				verificationObject = {
					"editor": currentAdmin.id,
					"grammarGuru": currentAdmin.roles.grammarGuru ? currentAdmin.id : null,
					"templateGuru": currentAdmin.roles.templateGuru ? currentAdmin.id : null,
					"rulesGuru": currentAdmin.roles.rulesGuru ? currentAdmin.id : null
				};
				if (verificationObject.grammarGuru !== null && verificationObject.templateGuru !== null && verificationObject.rulesGuru !== null) {
					newStatus = "finished";
					action = "approved and verified";
					action2 = "approval and verification";
				} else {
					newStatus = "awaiting verification";
					action = "approved";
					action2 = "approval";
				}
			} else if (oldQuestion.status === "awaiting verification") {
				verificationObject = JSON.parse(oldQuestion.verification);
				for (let i of ["grammarGuru", "templateGuru", "rulesGuru"]) {
					if (currentAdmin.roles[i]) {
						verificationObject[i] = currentAdmin.id;
					}
				}
				if (verificationObject.grammarGuru !== null && verificationObject.templateGuru !== null && verificationObject.rulesGuru!== null) {
					newStatus = "finished";
					action = "verified";
					action2 = "verification";
				} else {
					newStatus = "awaiting verification";
					action = "verified";
					action2 = "verification";
				}
			}
		} else if (statusChange === "decrease") {
			if (oldQuestion.status === "awaiting verification") {
				if (currentAdmin.id === JSON.parse(oldQuestion.verification).editor) {
					newStatus = "pending";
					action = "unapproved";
					action2 = "unapproval";
					verificationObject = {
						"editor": null,
						"grammarGuru": null,
						"templateGuru": null,
						"rulesGuru": null
					};
				} else {
					newStatus = "awaiting verification";
					action = "unverified";
					action2 = "unverification";
					verificationObject = JSON.parse(oldQuestion.verification);
					for (let i of ["grammarGuru", "templateGuru", "rulesGuru"]) {
						if (currentAdmin.roles[i]) {
							verificationObject[i] = null;
						}
					}
				}
			}
		}

		if (!newStatus) {
			res.json({
				"error": true,
				"message": "You do not have permission to perform this action."
			});
			return;
		}

		await dbRun(`UPDATE questions SET json = '${JSON.stringify(req.body.questionObj).replace(/'/g,"''")}', status = '${newStatus}', verification = '${JSON.stringify(verificationObject).replace(/'/g,"''")}' WHERE id = ${req.body.questionObj.id}`);

		res.json({
			"error": false,
			"message": `Question #${req.body.questionObj.id} ${action} successfully.`,
			"newStatus": newStatus,
			"newVerification": verificationObject
		});

		//Update the reference question array
		if (newStatus === "finished") {
			let newQuestion = req.body.questionObj;
			const allCards = JSON.parse(fs.readFileSync("allCards.json", "utf8"));
			newQuestion = convertAllTemplates(newQuestion, allCards);

			//Check for a template that generated 0 cards.
			let emptyTemplate = false;
			for (let j = 0 ; j < newQuestion.cardLists.length ; j++) {
				if (newQuestion.cardLists[j].length === 0) {
					emptyTemplate = true;
				}
			}
			if (emptyTemplate) {
				sendEmailToOwners("RulesGuru template error", `Question ${newQuestion.id} generates an empty template.\n\nhttps://rulesguru.net/question-editor/?${newQuestion.id}`);
			}
			referenceQuestionArray.push(newQuestion);
		} else if (statusChange === "decrease") {
			for (let i in referenceQuestionArray) {
				if (referenceQuestionArray[i].id === req.body.questionObj.id) {
					referenceQuestionArray.splice(i, 1);
				}
			}
		}

		//Send emails about the change.
		if (currentAdmin.sendSelfEditLogEmails) {
			transporter.sendMail({
				from: "admin@rulesguru.net",
				to: currentAdmin.emailAddress,
				subject: `Your RulesGuru admin ${action2}`,
				text: `You've ${action} question #${req.body.questionObj.id} (${newStatus}).\n\nhttps://rulesguru.net/question-editor/?${req.body.questionObj.id}\n\nTime: ${date}\n\n\nOld question:\n\n${JSON.stringify(JSON.parse(oldQuestion.json), null, 2)}\n\n\nNew question:\n\n${JSON.stringify(req.body.questionObj, null, 2)}`
			}, function(err) {
					if (err) {
						handleError(err);
					}
			});
		}

		if (!currentAdmin.roles.owner) {
			sendEmailToOwners(`RulesGuru admin ${action2} (${currentAdmin.name})`, `${currentAdmin.name} has ${action} question #${req.body.questionObj.id}(${newStatus}).\n\nhttps://rulesguru.net/question-editor/?${req.body.questionObj.id}\n\nTime: ${date}\n\n\nOld question:\n\n${JSON.stringify(JSON.parse(oldQuestion.json), null, 2)}\n\n\nNew question:\n\n${JSON.stringify(req.body.questionObj, null, 2)}`);
		}

		if (typeof req.body.changes === "string") {
			const allAdmins = JSON.parse(fs.readFileSync("admins.json", "utf8"));
			sendEmailToOwners("RulesGuru admin verification with changes", `${currentAdmin.name} has verified question #${req.body.questionObj.id} (originally approved by ${allAdmins[verificationObject.editor].name}) with the following changes:\n\n${req.body.changes}`);

			transporter.sendMail({
				from: "admin@rulesguru.net",
				to: allAdmins[verificationObject.editor].emailAddress,
				subject: `RulesGuru question verification feedback`,
				text: `Your question https://rulesguru.net/question-editor/?${req.body.questionObj.id} has been verified with the following feedback:\n\n${req.body.changes}`
			}, function(err) {
					if (err) {
						handleError(err);
					}
			});
		}

		updateIndexQuestionCount();
	}
});

let addQuestionRunning = false;
const addQuestion = async function(question, isAdmin, adminId) {
	if (addQuestionRunning) {
		await new Promise(r => setTimeout(r, 50)); //sleep for 50 milliseconds
		return await addQuestion(question, isAdmin, adminId);
	} else {
		addQuestionRunning = true;
		try {
			let existingIds = await dbAll(`SELECT id FROM questions`);
			existingIds = existingIds.map(entry => entry.id);
			existingIds.sort((a, b) => a - b);
			if (existingIds.length !== Array.from(new Set(existingIds)).length) {
				handleError(new Error("Duplicate IDs in array."));
				return;
			}
			const validNewIds = [];
			let count = 1;
			while (validNewIds.length < 1000) {
				if (existingIds[0] === count) {
					existingIds.shift();
				} else {
					validNewIds.push(count);
				}
				count++;
			}
			const newId = validNewIds[Math.floor(Math.random() * 1000)];

			question.id = newId;
			let verificationJson,
					newStatus;

			question.submissionDate = Date.now();

			if (isAdmin) {
				const allAdmins = JSON.parse(fs.readFileSync("admins.json", "utf8"));
				const currentAdmin = allAdmins[adminId];
				verificationJson = JSON.stringify({
					"editor": currentAdmin.id,
					"grammarGuru": currentAdmin.roles.grammarGuru ? currentAdmin.id : null,
					"templateGuru": currentAdmin.roles.templateGuru ? currentAdmin.id : null,
					"rulesGuru": currentAdmin.roles.rulesGuru ? currentAdmin.id : null
				});

				if (currentAdmin.roles.grammarGuru && currentAdmin.roles.templateGuru && currentAdmin.roles.rulesGuru) {
					newStatus = "finished";
					await dbRun(`INSERT INTO questions ("id", "json", "status", "verification") VALUES (${newId}, '${JSON.stringify(question).replace(/'/g,"''")}', '${newStatus}', '${verificationJson.replace(/'/g,"''")}')`);
				} else {
					newStatus = "awaiting verification";
					await dbRun(`INSERT INTO questions ("id", "json", "status", "verification") VALUES (${newId}, '${JSON.stringify(question).replace(/'/g,"''")}', '${newStatus}', '${verificationJson.replace(/'/g,"''")}')`);
				}
			} else {
				verificationJson = JSON.stringify({
					"editor": null,
					"grammarGuru": null,
					"templateGuru": null,
					"rulesGuru": null
				});
				newStatus = "pending";
				await dbRun(`INSERT INTO questions ("id", "json", "status", "verification") VALUES (${newId}, '${JSON.stringify(question).replace(/'/g,"''")}', '${newStatus}', '${verificationJson}')`);
			}

			addQuestionRunning = false;
			return {
				"newId": newId,
				"newStatus": newStatus,
				"newVerification": JSON.parse(verificationJson)
			};
		} catch (error) {
			handleError(error);
			addQuestionRunning = false;
			return {
				"error": error.message
			};
		}
	}
}

app.post("/getUnfinishedQuestion", async function(req, res) {
	const validateAdminResult = validateAdmin(req.body.password);
	let currentAdmin;
	if (typeof validateAdminResult === "string") {
		res.json({
			"error": true,
			"message": validateAdminResult
		});
		return;
	} else {
		currentAdmin = validateAdminResult;

		let allQuestions = await dbAll(`SELECT * FROM questions`);

		const result = getUnfinishedQuestion(currentAdmin, allQuestions);
		if (result) {
			const question = JSON.parse(result.json);
			question.status = result.status;
			question.verification = JSON.parse(result.verification);
			res.json({
				"error": false,
				"question": question
			});
		} else {
			res.json({
				"error": true,
				"message": "No unfinished questions."
			});
		}
	}
});

app.post("/getSpecificAdminQuestion", function(req, res) {
	const validateAdminResult = validateAdmin(req.body.password);
	let currentAdmin;
	if (typeof validateAdminResult === "string") {
		res.send(validateAdminResult);
	} else {
		currentAdmin = validateAdminResult;

		if (!Number.isNaN(parseInt(req.body.id))) {
			db.get(`SELECT * FROM questions WHERE id = ${req.body.id}`, function(err, result) {
				if (err) {
					handleError(err);
				} else {
					if (result) {
						const questionToSend = JSON.parse(result.json);
						questionToSend.status = result.status;
						questionToSend.verification = JSON.parse(result.verification);

						res.send(questionToSend);
					} else {
						res.send("That question doesn't exist.");
					}
				}
			});
		} else {
			res.send("That question doesn't exist.")
		}
	}
});

app.post("/getQuestionsList", function(req, res) {
	const allCards = JSON.parse(fs.readFileSync("allCards.json", "utf8"));
	let questionArray = JSON.parse(JSON.stringify(referenceQuestionArray));
	const validQuestionsList = [];

	for (let i = 0 ; i < questionArray.length ; i++) {
		const result = questionMatchesSettings(questionArray[i], req.body.settings, allCards);
		if (result) {
			validQuestionsList.push(questionArray[i].id);
		}
	}

	res.json(validQuestionsList.sort(function(a, b) {
		return a - b;
	}));
});

app.post("/submitQuestion", async function(req, res) {
	//Add missing values.
	req.body.level = "";
	req.body.complexity = "";
	req.body.tags = [];
	req.body.cardGenerators = [];
	//Fix problems
	const normalizeInput = function(text) {
		text = text.replace(/\[+/g, "[");
		text = text.replace(/\]+/g, "]");
		text = text.replace("!card ", "");
		text = text.replace("!", "");
		text = text.trim();
		return text;
	}
	req.body.question = normalizeInput(req.body.question);
	req.body.answer = normalizeInput(req.body.answer);

	const addQuestionResult = await addQuestion(req.body, false);
	if (!addQuestionResult.error) {
		res.send(`Question #${addQuestionResult.newId} submitted successfully. Thanks!`);
	} else {
		res.send(`Your question encountered an error being submitted. (${addQuestionResult.error}) Please report this issue using the contact form in the upper right.`);
	}
});

app.post("/validateLogin", function(req, res) {
	const validateAdminResult = validateAdmin(req.body.password);
	let currentAdmin;
	if (typeof validateAdminResult === "string") {
		res.send(validateAdminResult);
	} else {
		currentAdmin = validateAdminResult;
		res.json({
			"name": currentAdmin.name,
			"roles": currentAdmin.roles,
			"id": currentAdmin.id
		});
	}
});

app.post("/logSearchLinkData", function(req, res) {
	let searchLinkLog = JSON.parse(fs.readFileSync("logs/searchLinkLog.json", "utf8"));
	searchLinkLog.push({"date": Date.now(), "request": req.body});
	fs.writeFileSync("logs/searchLinkLog.json", JSON.stringify(searchLinkLog));
});

app.get("/getTagData", function(req, res) {
	const tagData = {};
	const allTags = JSON.parse(fs.readFileSync("public_html/globalResources/allTags.js", "utf8").slice(14));
	for (let i in allTags) {
		tagData[allTags[i]] = {
			"name": i,
			"count": 0
		}
	}
	for (let i in referenceQuestionArray) {
		referenceQuestionArray[i].tags.forEach(function(tag) {
			tagData[tag].count++;
		})
	}

	res.send(tagData);
});

app.post("/getAdminData", function(req, res) {
	if (req.body.includeSensitiveData) {
		const validateAdminResult = validateAdmin(req.body.password);
		if (typeof validateAdminResult === "object" && validateAdminResult.roles.owner) {
			const adminData = JSON.parse(fs.readFileSync("admins.json", "utf8"));
			res.send(JSON.stringify(adminData));
		} else {
			res.send("Unauthorized");
		}
	} else {
		const dataToSend = [];
		const adminData = JSON.parse(fs.readFileSync("admins.json", "utf8"));
		for (let i in adminData) {
			dataToSend.push({
				"name": adminData[i].name,
				"roles": adminData[i].roles,
				"id": adminData[i].id
			});
		}
		res.send(JSON.stringify(dataToSend));
	}
});

app.post("/updateAdminData", function(req, res) {
	const validateAdminResult = validateAdmin(req.body.password);
	if (typeof validateAdminResult === "object" && validateAdminResult.roles.owner) {
		fs.writeFileSync("admins.json", req.body.adminData);
		res.send("Updated");
	} else {
		res.send("Unauthorized");
	}
});

app.post("/updateAndForceStatus", async function(req, res) {
	const validateAdminResult = validateAdmin(req.body.password);
	if (typeof validateAdminResult === "string") {
		res.json({
			"error": true,
			"message": validateAdminResult
		});
	} else if (!validateAdminResult.roles.owner) {
		res.json({
			"error": true,
			"message": "You do not have permission to perform this action."
		});
	} else {
		const currentAdmin = validateAdminResult;
		if (!(Number.isInteger(req.body.id) && req.body.id > 0)) {
			res.json({
				"error": true,
				"message": "That question doesn't exist."
			});
			return;
		}
		if (req.body.newId !== undefined && (req.body.newId < 1 || req.body.newId > 9999)) {
			res.json({
				"error": true,
				"message": `${req.body.newId} is not a valid new ID.`
			});
			return;
		}
		if (req.body.newId) {
			const questionAtTargetId = await dbGet(`SELECT * FROM questions WHERE id = ${req.body.newId}`);
			if (questionAtTargetId) {
				res.json({
					"error": true,
					"message": `There is already a question at ID #${req.body.newId}.`
				});
				return;
			}
		}
		const oldQuestion = await dbGet(`SELECT * FROM questions WHERE id = ${req.body.id}`);
		if (!oldQuestion) {
			res.json({
				"error": true,
				"message": "That question doesn't exist."
			});
			return;
		}

		const newVerificationObject = {
			"editor": null,
			"grammarGuru": null,
			"templateGuru": null,
			"rulesGuru":  null
		};

		if (req.body.newStatus === "finished") {
			newVerificationObject.editor = currentAdmin.id;
			newVerificationObject.grammarGuru = currentAdmin.id;
			newVerificationObject.templateGuru = currentAdmin.id;
			newVerificationObject.rulesGuru = currentAdmin.id;
		}

		await dbRun(`UPDATE questions SET status = '${req.body.newStatus}', verification = '${JSON.stringify(newVerificationObject).replace(/'/g,"''")}', json = '${JSON.stringify(req.body.questionData).replace(/'/g,"''")}', id = '${req.body.newId || req.body.id}' WHERE id = ${req.body.id}`);

		//Update the reference question array
		for (let i in referenceQuestionArray) {
			if (referenceQuestionArray[i].id === req.body.id) {
				referenceQuestionArray.splice(i, 1);
				break;
			}
		}
		if (req.body.newStatus === "finished") {
			let newQuestion = req.body.questionData;
			const allCards = JSON.parse(fs.readFileSync("allCards.json", "utf8"));
			newQuestion = convertAllTemplates(newQuestion, allCards);

			//Check for a template that generated 0 cards.
			let emptyTemplate = false;
			for (let j = 0 ; j < newQuestion.cardLists.length ; j++) {
				if (newQuestion.cardLists[j].length === 0) {
					emptyTemplate = true;
				}
			}
			if (emptyTemplate) {
				sendEmailToOwners("RulesGuru template error", `Question ${newQuestion.id} generates an empty template.\n\nhttps://rulesguru.net/question-editor/?${newQuestion.id}`);
			}
			referenceQuestionArray.push(newQuestion);
		}

		updateIndexQuestionCount();

		res.json({
			"error": false,
			"message": `Question #${req.body.id} modified successfully.${req.body.newId ? ` (New ID #${req.body.newId})` : ""}`,
			"newStatus": req.body.newStatus,
			"newVerification": newVerificationObject,
			"newId": req.body.newId
		});

		if (req.body.newId) {

			const date = Date();
			sendEmailToOwners(`RulesGuru question ID change`, `${currentAdmin.name} has moved question #${req.body.id} to ID #${req.body.newId}.\n\nTime: ${date}`);
		}
	}
});

app.get("/mostPlayedStandard", function(req, res) {
	res.send(fs.readFileSync("data_files/mostPlayedStandard.json", "utf8"));
});
app.get("/mostPlayedPioneer", function(req, res) {
	res.send(fs.readFileSync("data_files/mostPlayedPioneer.json", "utf8"));
});
app.get("/mostPlayedModern", function(req, res) {
	res.send(fs.readFileSync("data_files/mostPlayedModern.json", "utf8"));
});
