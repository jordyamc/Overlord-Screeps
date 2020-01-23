/*
 * Copyright (c) 2020.
 * Github - Shibdib
 * Name - Bob Sardinia
 * Project - Overlord-Bot (Screeps)
 */

/**
 * Created by rober on 6/21/2017.
 */

let tradeAmount = MINERAL_TRADE_AMOUNT;
let reactionAmount = REACTION_AMOUNT;
let runOnce, globalOrders, lastPriceAdjust, spendingMoney;
if (Memory._banker) spendingMoney = Memory._banker.spendingAccount; else spendingMoney = 0;

module.exports.terminalControl = function (room) {
    Memory.saleTerminal = Memory.saleTerminal || {};
    let myOrders = Game.market.orders;
    //Things that don't need to be run for every terminal
    if (runOnce !== Game.time) {
        Memory._banker.spendingAccount = _.floor(spendingMoney, 1);
        // Track profits
        profitCheck();
        // Reaction amount is 500 if we are low on cash
        if (Game.market.credits < CREDIT_BUFFER) reactionAmount = 500; else reactionAmount = REACTION_AMOUNT;
        //Get global orders
        globalOrders = Game.market.getAllOrders();
        //Cleanup broken or old orders
        orderCleanup(myOrders);
        //Handle Sell Orders
        manageSellOrders(myOrders);
        //Update prices
        if (lastPriceAdjust + 100 < Game.time) {
            pricingUpdateSell(globalOrders, myOrders);
            lastPriceAdjust = Game.time;
        }
        // Set saleTerminal
        if (!Memory.saleTerminal.room || Memory.saleTerminal.saleSet + 15000 < Game.time) {
            if (Memory.saleTerminal.room && Game.rooms[Memory.saleTerminal.room].controller.level === Memory.maxLevel) {
                return Memory.saleTerminal.saleSet = Game.time;
            }
            Memory.saleTerminal.room = _.sample(_.filter(Game.structures, (s) => s.structureType === STRUCTURE_TERMINAL && s.room.level === Memory.maxLevel && s.isActive() && _.sum(s.store) < s.store.getCapacity() * 0.9)).room.name;
            Memory.saleTerminal.saleSet = Game.time;
        }
        runOnce = Game.time;
    }
    if (room.terminal.cooldown) return;
    if (room.terminal.store[RESOURCE_ENERGY]) {
        //Send energy to rooms under siege
        if (emergencyEnergy(room.terminal)) return;
        //Disperse Minerals and Boosts
        if (balanceResources(room.terminal)) return;
        if (room.name === Memory.saleTerminal.room && spendingMoney > 0) {
            //Buy resources being sold at below market value
            if (dealFinder(room.terminal, globalOrders)) return;
            //Buy Energy
            if (buyEnergy(room.terminal, globalOrders)) return;
            //Buy Power
            if (buyPower(room.terminal, globalOrders)) return;
        }
    }
    //Buy minerals if needed
    if (baseMineralOnDemandBuys(room.terminal, globalOrders)) return;
    //Dump Excess
    if (fillBuyOrders(room.terminal, globalOrders)) return;
    // Place sell orders
    if (room.name === Memory.saleTerminal.room) placeSellOrders(room.terminal, globalOrders, myOrders);
};

function orderCleanup(myOrders) {
    let myRooms = _.filter(Game.rooms, (r) => r.energyAvailable && r.controller.owner && r.controller.owner.username === MY_USERNAME);
    for (let key in myOrders) {
        let order = myOrders[key];
        if (!order.active) {
            if (Game.market.cancelOrder(order.id) === OK) {
                log.e("Order Cancelled: " + order.id + " no longer active.", 'MARKET: ');
                return true;
            }
        }
        if (order.type === ORDER_BUY) {
            if (Game.market.credits < 50) {
                if (Game.market.cancelOrder(order.id) === OK) {
                    log.e("Order Cancelled: " + order.id + " due to low credits", 'MARKET: ');
                    return true;
                }
            }
            // Remove duplicates for same resource
            let duplicate = _.filter(myOrders, (o) => o.roomName === order.roomName &&
                o.resourceType === order.resourceType && o.type === ORDER_BUY && o.id !== order.id);
            if (duplicate.length) {
                duplicate.forEach((duplicateOrder) => Game.market.cancelOrder(duplicateOrder.id))
            }
            if (order.resourceType !== RESOURCE_ENERGY) {
                if (order.remainingAmount > tradeAmount) {
                    if (Game.market.cancelOrder(order.id) === OK) {
                        log.e("Order Cancelled: " + order.id + " for exceeding the set trade amount (order amount/set limit) " + order.remainingAmount + "/" + tradeAmount, 'MARKET: ');
                        return true;
                    }
                }
            } else if (order.resourceType === RESOURCE_ENERGY) {
                if (_.filter(myRooms, (r) => r.terminal && r.energy >= ENERGY_AMOUNT * 2)[0]) {
                    if (Game.market.cancelOrder(order.id) === OK) {
                        log.e("Order Cancelled: " + order.id + " we have a room with an energy surplus and do not need to purchase energy", 'MARKET: ');
                        return true;
                    }
                }
            }
            if (order.amount === 0) {
                if (Game.market.cancelOrder(order.id) === OK) {
                    log.e("Order Cancelled: " + order.id + " - Order Fulfilled.", 'MARKET: ');
                    return true;
                }
            }
        } else {
            if (order.roomName !== Memory.saleTerminal.room) {
                if (Game.market.cancelOrder(order.id) === OK) {
                    log.e("Order Cancelled: " + order.id + " - Not the designated sale terminal.", 'MARKET: ');
                    return true;
                }
            } else if (order.resourceType !== RESOURCE_ENERGY) {
                if (!order.amount) {
                    if (Game.market.cancelOrder(order.id) === OK) {
                        log.e("Order Cancelled: " + order.id + " - Not enough resources remaining in terminal.", 'MARKET: ');
                        return true;
                    }
                }
            } else if (Game.rooms[order.roomName].energy < ENERGY_AMOUNT) {
                if (Game.market.cancelOrder(order.id) === OK) {
                    log.e("Order Cancelled: " + order.id + " - Cancel sale of energy as we have a shortage in the room.", 'MARKET: ');
                    return true;
                }
            }
        }
        if (!Game.rooms[order.roomName]) {
            if (Game.market.cancelOrder(order.id) === OK) {
                log.e("Order Cancelled: " + order.id + " we no longer own this room", 'MARKET: ');
                return true;
            }
        }
    }
}

function pricingUpdateSell(globalOrders, myOrders) {
    for (let key in myOrders) {
        let order = myOrders[key];
        if (order.type === ORDER_SELL) {
            let currentPrice = order.price;
            let newPrice = currentPrice;
            let competitorOrder = _.min(globalOrders.filter(o => !_.includes(Memory.myRooms, o.roomName) && o.resourceType === order.resourceType && o.type === ORDER_SELL), 'price');
            if (competitorOrder) {
                newPrice = competitorOrder.price - 0.001;
            } else if (latestMarketHistory(order.resourceType)) {
                newPrice = latestMarketHistory(order.resourceType)['avgPrice'];
            }
            let cost = 0;
            if (currentPrice < newPrice) {
                cost = (newPrice - currentPrice) * order.remainingAmount * 0.05;
            }
            let availableCash = Game.market.credits - CREDIT_BUFFER;
            if (currentPrice !== newPrice && cost <= availableCash) {
                if (Game.market.changeOrderPrice(order.id, newPrice) === OK) {
                    log.w("Sell order price change " + order.id + " new/old " + newPrice + "/" + order.price + " Resource - " + order.resourceType, "Market: ");
                }
            }
        }
    }
}

function manageSellOrders(myOrders) {
    for (let key in myOrders) {
        let order = myOrders[key];
        if (order.type !== ORDER_SELL) continue;
        if (order.resourceType !== RESOURCE_ENERGY) {
            if (Game.rooms[order.roomName].terminal.store[order.resourceType] - order.remainingAmount > 1500) {
                let amount = Game.rooms[order.roomName].terminal.store[order.resourceType] - order.remainingAmount;
                if (amount > 0) {
                    let cost = order.price * amount * 0.05;
                    let availableCash = Game.market.credits - CREDIT_BUFFER;
                    if (cost > availableCash) amount = _.round(availableCash / (order.price * 0.05));
                    if (Game.market.extendOrder(order.id, amount) === OK) {
                        log.w("Extended sell order " + order.id + " an additional " + amount + " " + order.resourceType + " in " + roomLink(order.roomName), "Market: ");
                        return true;
                    }
                }
            }
        }
    }
}

function placeSellOrders(terminal, globalOrders, myOrders) {
    for (let resourceType of Object.keys(terminal.store)) {
        let availableCash = Game.market.credits - CREDIT_BUFFER;
        if (availableCash <= 0) return false;
        // No energy
        if (resourceType === RESOURCE_ENERGY) continue;
        // No base minerals if we can produce commodities
        if (terminal.room.level >= 7 && _.includes(BASE_MINERALS, resourceType)) continue;
        // Avoid Duplicates
        if (_.filter(myOrders, (o) => o.roomName === terminal.pos.roomName && o.resourceType === resourceType && o.type === ORDER_SELL).length) continue;
        // Handle minerals
        if (_.includes(_.union(BASE_MINERALS, BASE_COMPOUNDS), resourceType) && terminal.room.store(resourceType) < reactionAmount) continue;
        // Handle boosts
        if (_.includes(_.union(TIER_1_BOOSTS, TIER_2_BOOSTS, TIER_3_BOOSTS, [RESOURCE_POWER]), resourceType) && terminal.room.store(resourceType) < BOOST_TRADE_AMOUNT) continue;
        // Sell
        let price = 5;
        let competitorOrder = _.min(globalOrders.filter(order => !_.includes(Memory.myRooms, order.roomName) && order.resourceType === resourceType && order.type === ORDER_SELL), 'price');
        if (competitorOrder) {
            price = competitorOrder.price - 0.001;
        } else if (latestMarketHistory(resourceType)) {
            price = latestMarketHistory(resourceType)['avgPrice'];
        }
        let amount = terminal.room.store(resourceType) - reactionAmount;
        if (amount > terminal.store[resourceType]) amount = terminal.store[resourceType];
        let cost = price * amount * 0.05;
        if (cost > availableCash) amount = _.round(availableCash / (price * 0.05));
        if (Game.market.createOrder(ORDER_SELL, resourceType, price, amount, terminal.pos.roomName) === OK) {
            log.w("New Sell Order: " + resourceType + " at/per " + price + ' in ' + roomLink(terminal.room.name), "Market: ");
            return true;
        }
    }
}

function baseMineralOnDemandBuys(terminal, globalOrders) {
    for (let mineral of shuffle(BASE_MINERALS)) {
        // Don't buy minerals you can mine
        if (_.includes(OWNED_MINERALS, mineral)) continue;
        let stored = terminal.room.store(mineral) || 0;
        if (stored < reactionAmount * 0.8) {
            let buyAmount = reactionAmount - stored;
            if (Game.market.credits < CREDIT_BUFFER) _.round(buyAmount *= (Game.market.credits / CREDIT_BUFFER));
            let sellOrder = _.min(globalOrders.filter(order => order.resourceType === mineral && order.type === ORDER_SELL && !_.includes(Memory.myRooms, order.roomName)), 'price');
            if (sellOrder.price * buyAmount > spendingMoney) buyAmount = _.round(spendingMoney / sellOrder.price);
            if (sellOrder.id && buyAmount >= 50) {
                if (buyAmount > sellOrder.amount) buyAmount = sellOrder.amount;
                if (Game.market.deal(sellOrder.id, buyAmount, terminal.pos.roomName) === OK) {
                    log.w("Bought " + buyAmount + " " + mineral + " for " + (sellOrder.price * buyAmount) + " credits in " + roomLink(terminal.room.name), "Market: ");
                    spendingMoney -= (sellOrder.price * buyAmount);
                    log.w("Remaining spending account amount - " + spendingMoney, "Market: ");
                    return true;
                }
            }
        }
    }
}

function buyPower(terminal, globalOrders) {
    let stored = terminal.store[RESOURCE_POWER] + terminal.room.storage.store[RESOURCE_POWER] || 0;
    if (stored >= reactionAmount) return;
    let buyAmount = reactionAmount - stored;
    if (buyAmount >= 1000) {
        let sellOrder = _.min(globalOrders.filter(order => order.resourceType === RESOURCE_POWER &&
            order.type === ORDER_SELL && order.remainingAmount >= buyAmount && order.roomName !== terminal.pos.roomName &&
            Game.market.calcTransactionCost(buyAmount, terminal.room.name, order.roomName) < terminal.store[RESOURCE_ENERGY]), 'price');
        if (sellOrder.price * buyAmount > spendingMoney) buyAmount = _.round(buyAmount * ((spendingMoney) / (sellOrder.price * buyAmount)));
        if (buyAmount >= 500 && sellOrder.id) {
            if (Game.market.deal(sellOrder.id, buyAmount, terminal.pos.roomName) === OK) {
                log.w("Bought " + buyAmount + " POWER for " + (sellOrder.price * buyAmount) + " credits in " + roomLink(terminal.room.name), "Market: ");
                spendingMoney -= (sellOrder.price * buyAmount);
                log.w("Remaining spending account amount - " + spendingMoney, "Market: ");
                return true;
            }
        }
    }
}

function buyEnergy(terminal, globalOrders) {
    if (terminal.room.energy < ENERGY_AMOUNT && BUY_ENERGY) {
        let sellOrder = _.min(globalOrders.filter(order => order.resourceType === RESOURCE_ENERGY &&
            order.type === ORDER_SELL && !_.includes(Memory.myRooms, order.roomName)), 'price');
        if (sellOrder.price) {
            let buyAmount = sellOrder.amount;
            if (sellOrder.price * buyAmount > spendingMoney) buyAmount = _.round(buyAmount * ((spendingMoney) / (sellOrder.price * buyAmount)));
            if (buyAmount >= 1000 && Game.market.deal(sellOrder.id, buyAmount, terminal.pos.roomName) === OK) {
                log.w("Bought " + buyAmount + " " + sellOrder.resourceType + " for " + (sellOrder.price * buyAmount) + " credits in " + roomLink(terminal.room.name), "Market: ");
                spendingMoney -= (sellOrder.price * buyAmount);
                log.w("Remaining spending account amount - " + spendingMoney, "Market: ");
                return true;
            }
        }
    }
}

function fillBuyOrders(terminal, globalOrders) {
    if (!terminal.store[RESOURCE_ENERGY]) return;
    for (let resourceType of _.shuffle(Object.keys(terminal.store))) {
        if (resourceType === RESOURCE_ENERGY) continue;
        // Only fill buy orders if we need credits or have too much
        let sellAmount = terminal.store[resourceType] - reactionAmount;
        if (resourceType === RESOURCE_OPS) sellAmount = terminal.store[resourceType];
        if (terminal.store[resourceType] > DUMP_AMOUNT || (sellAmount > 0 && Game.market.credits < CREDIT_BUFFER)) {
            let buyer = _.max(globalOrders.filter(order => order.resourceType === resourceType && order.type === ORDER_BUY && order.roomName !== terminal.pos.roomName &&
                Game.market.calcTransactionCost(500, terminal.room.name, order.roomName) < terminal.store[RESOURCE_ENERGY]), 'price');
            if (buyer.id) {
                if (buyer.remainingAmount < sellAmount) sellAmount = buyer.remainingAmount;
                if (Game.market.calcTransactionCost(sellAmount, terminal.room.name, buyer.roomName) > terminal.store[RESOURCE_ENERGY]) sellAmount = 500;
                if (sellAmount * buyer.price >= 5) {
                    switch (Game.market.deal(buyer.id, sellAmount, terminal.pos.roomName)) {
                        case OK:
                            log.w(terminal.pos.roomName + " Sell Off Completed - " + resourceType + " for " + (buyer.price * sellAmount) + " credits in " + roomLink(terminal.room.name), "Market: ");
                            spendingMoney += ((buyer.price * sellAmount) * 0.75);
                            log.w("New spending account amount - " + spendingMoney, "Market: ");
                            return true;
                    }
                }
            } // Offload if we're overflowing
            else if (_.sum(terminal.store) >= terminal.store.getCapacity() * 0.95 && terminal.store[resourceType] >= DUMP_AMOUNT) {
                let alliedRoom = _.sample(_.filter(Memory.roomCache, (r) => r.user && r.user !== MY_USERNAME && _.includes(FRIENDLIES, r.user) && r.level >= 6));
                let randomRoom = _.sample(_.filter(Memory.roomCache, (r) => r.user && r.user !== MY_USERNAME && !_.includes(FRIENDLIES, r.user) && r.level >= 6)) || _.sample(_.filter(Memory.roomCache, (r) => r.user && r.user !== MY_USERNAME && r.level >= 6));
                if (alliedRoom && (_.includes(TIER_3_BOOSTS, resourceType) || _.includes(TIER_2_BOOSTS, resourceType))) {
                    alliedRoom = alliedRoom.name;
                    switch (terminal.send(resourceType, 1000, alliedRoom)) {
                        case OK:
                            return true;
                    }
                } else if (randomRoom) {
                    randomRoom = randomRoom.name;
                    switch (terminal.send(resourceType, 1000, randomRoom)) {
                        case OK:
                            return true;
                    }
                }
            }
        }
    }
}

function balanceResources(terminal) {
    // Loop resources
    for (let resource of Object.keys(terminal.store)) {
        // Energy balance handled elsewhere
        if (resource === RESOURCE_ENERGY) continue;
        let keepAmount = reactionAmount;
        let stockpile;
        if (_.includes(ALL_COMMODITIES, resource) || resource === RESOURCE_OPS || resource === RESOURCE_POWER) {
            keepAmount = 0;
            stockpile = true;
        }
        if (_.includes(LAB_PRIORITY, resource) && terminal.room.store(resource) < BOOST_TRADE_AMOUNT) {
            continue;
        } else if (_.includes(LAB_PRIORITY, resource)) {
            keepAmount = BOOST_TRADE_AMOUNT;
        } else if (terminal.room.store(resource) < reactionAmount) {
            continue;
        }
        let available = terminal.room.store(resource) - keepAmount;
        if (available <= 0) continue;
        let needyTerminal = _.sortBy(_.filter(Game.structures, (r) => r.structureType === STRUCTURE_TERMINAL && r.room.name !== terminal.room.name && r.room.store(resource) < keepAmount), function (s) {
            s.room.store(resource);
        })[0];
        let sendAmount = available - keepAmount;
        if (sendAmount <= 100) continue;
        if (needyTerminal && !stockpile) {
            sendAmount = keepAmount - needyTerminal.room.store(resource);
            if (sendAmount > terminal.store[resource]) sendAmount = terminal.store[resource];
            switch (terminal.send(resource, sendAmount, needyTerminal.room.name)) {
                case OK:
                    log.a('Balancing ' + sendAmount + ' ' + resource + ' To ' + roomLink(needyTerminal.room.name) + ' From ' + roomLink(terminal.room.name), "Market: ");
                    return true;
            }
        } else if (terminal.room.name !== Memory.saleTerminal.room) {
            if (sendAmount <= 500) continue;
            let energyCost = Game.market.calcTransactionCost(sendAmount, terminal.room.name, Memory.saleTerminal.room);
            if (energyCost > terminal.store[RESOURCE_ENERGY]) sendAmount = 500;
            switch (terminal.send(resource, sendAmount, Memory.saleTerminal.room)) {
                case OK:
                    log.a('Sent ' + sendAmount + ' ' + resource + ' To ' + roomLink(Memory.saleTerminal.room) + ' From ' + roomLink(terminal.room.name) + ' to sell on the market.', "Market: ");
                    return true;
            }
        }
    }
    if (Memory.roomCache[terminal.room.name].threatLevel >= 3) return false;
    // Find needy terminals
    let needyTerminal = _.min(_.filter(Game.structures, (r) => r.structureType === STRUCTURE_TERMINAL && r.room.name !== terminal.room.name && r.room.energy < terminal.room.energy * 0.85), '.room.energy');
    if (needyTerminal.id) {
        // Determine how much you can move
        let availableAmount = terminal.store[RESOURCE_ENERGY] - (TERMINAL_ENERGY_BUFFER * 0.5);
        let requestedAmount = (terminal.room.energy - needyTerminal.room.energy) * 0.5;
        if (requestedAmount > availableAmount) requestedAmount = availableAmount;
        if (requestedAmount > 1000) {
            switch (terminal.send(RESOURCE_ENERGY, requestedAmount, needyTerminal.room.name)) {
                case OK:
                    log.a('Balancing ' + requestedAmount + ' ' + RESOURCE_ENERGY + ' To ' + roomLink(needyTerminal.room.name) + ' From ' + roomLink(terminal.room.name), "Market: ");
                    return true;
            }
        }
    }
}

function emergencyEnergy(terminal) {
    // Balance energy
    if (terminal.store[RESOURCE_ENERGY] && !Memory.roomCache[terminal.room.name].requestingSupport) {
        // Find needy terminals
        let myRooms = _.filter(Game.rooms, (r) => r.energyAvailable && r.controller.owner && r.controller.owner.username === MY_USERNAME);
        let responseNeeded = _.min(_.filter(myRooms, (r) => r.name !== terminal.room.name && ((Memory.roomCache[r.name] && Memory.roomCache[r.name].threatLevel >= 3) || (r.memory.nuke > 1500)) && r.terminal && r.energy < ENERGY_AMOUNT * 2), '.energy');
        if (responseNeeded && responseNeeded.name) {
            let needyTerminal = responseNeeded.terminal;
            // Determine how much you can move
            let availableAmount = terminal.store[RESOURCE_ENERGY] - 5000;
            if (availableAmount <= 0) return false;
            switch (terminal.send(RESOURCE_ENERGY, availableAmount, needyTerminal.room.name)) {
                case OK:
                    log.a('Siege Supplies ' + availableAmount + ' ' + RESOURCE_ENERGY + ' To ' + roomLink(needyTerminal.room.name) + ' From ' + roomLink(terminal.room.name), "Market: ");
                    return true;
            }
        }
    } else if (Memory.roomCache[terminal.room.name].requestingSupport && terminal.room.energy < ENERGY_AMOUNT * 2 && Game.market.credits >= CREDIT_BUFFER * 0.25) {
        let sellOrder = _.min(globalOrders.filter(order => order.resourceType === RESOURCE_ENERGY && order.type === ORDER_SELL && order.remainingAmount >= 10000), 'price');
        if (sellOrder.id && sellOrder.price * 10000 < Game.market.credits * 0.1) {
            if (Game.market.deal(sellOrder.id, 10000, terminal.pos.roomName) === OK) {
                log.w("Bought " + 10000 + " " + RESOURCE_ENERGY + " for " + (sellOrder.price * 10000) + " credits", "Market: ");
                return true;
            }
        }
    }
}

function dealFinder(terminal, globalOrders) {
    let sellOrder = _.min(globalOrders.filter(order => order.type === ORDER_SELL && latestMarketHistory(order.resourceType) && order.price <= latestMarketHistory(order.resourceType)['avgPrice'] * 0.7 &&
        Game.market.calcTransactionCost(order.amount, terminal.room.name, order.roomName) < terminal.store[RESOURCE_ENERGY] * 0.5), 'price');
    let buyAmount = sellOrder.amount;
    if (sellOrder.price * buyAmount > spendingMoney) buyAmount = _.round(buyAmount * ((spendingMoney) / (sellOrder.price * buyAmount)));
    if (sellOrder.id && buyAmount >= 500) {
        if (Game.market.deal(sellOrder.id, buyAmount, terminal.pos.roomName) === OK) {
            log.w("Bought " + buyAmount + sellOrder.resourceType + " for " + (sellOrder.price * buyAmount) + " credits (DEAL FOUND!!) in " + roomLink(terminal.room.name), "Market: ");
            spendingMoney -= (sellOrder.price * buyAmount);
            log.w("Remaining spending account amount - " + spendingMoney, "Market: ");
            return true;
        }
    }
}

function latestMarketHistory(resource) {
    let history = Game.market.getHistory(resource);
    if (_.size(history)) {
        return history[_.size(history) - 1]
    } else {
        return false;
    }
}

function profitCheck(force = false) {
    let hourlyTick = EST_TICKS_PER_MIN * 60;
    let fiveMinuteTick = EST_TICKS_PER_MIN * 5;
    let profitTracking = Memory._banker || {};
    if (force || profitTracking.lastData + hourlyTick < Game.time || !profitTracking.lastData) {
        profitTracking.lastData = Game.time;
        let hourlyProfits = profitTracking.hourArray || [];
        let lastCredit = profitTracking.lastTotalAmount || Game.market.credits;
        profitTracking.lastTotalAmount = Game.market.credits;
        let hourChange = Game.market.credits - lastCredit;
        // Add 80% of profits for the hour to spending account
        if (hourChange > 0) {
            spendingMoney += (hourChange * 0.8);
            log.w("New spending account amount (HOURLY UPDATE) - " + spendingMoney, "Market: ");
        } else {
            spendingMoney += hourChange;
            log.w("New spending account amount (HOURLY UPDATE) - " + spendingMoney, "Market: ");
        }
        // Track profits
        if (hourlyProfits.length < 240) {
            hourlyProfits.push(hourChange)
        } else {
            hourlyProfits.shift();
            hourlyProfits.push(hourChange);
        }
        profitTracking.hourArray = hourlyProfits;
    } else if (profitTracking.lastInflux + fiveMinuteTick < Game.time || !profitTracking.lastInflux) {
        profitTracking.lastInflux = Game.time;
        if (Game.market.credits > CREDIT_BUFFER && Math.random() > 0.5) {
            let bankersCut = (Game.market.credits - CREDIT_BUFFER) * 0.8;
            spendingMoney += (bankersCut * 0.1);
            log.w("New spending account amount (RANDOM INFLUX) - " + spendingMoney, "Market: ");
        }
    }
    Memory._banker = profitTracking;
}