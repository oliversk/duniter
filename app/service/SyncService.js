var service    = require('../service');
var jpgp       = require('../lib/jpgp');
var async      = require('async');
var request    = require('request');
var mongoose   = require('mongoose');
var vucoin     = require('vucoin');
var _          = require('underscore');
var THTEntry   = mongoose.model('THTEntry');
var Amendment  = mongoose.model('Amendment');
var PublicKey  = mongoose.model('PublicKey');
var Membership = mongoose.model('Membership');
var Voting     = mongoose.model('Voting');
var Merkle     = mongoose.model('Merkle');
var Vote       = mongoose.model('Vote');
var Peer       = mongoose.model('Peer');
var Key        = mongoose.model('Key');
var Forward    = mongoose.model('Forward');
var Status     = require('../models/statusMessage');
var log4js     = require('log4js');
var logger     = log4js.getLogger('sync');
var mlogger    = log4js.getLogger('voting');
var vlogger    = log4js.getLogger('voting');

// Services
var ParametersService = service.Parameters;

module.exports.get = function (pgp, currency, conf) {

  this.createNext = function (am, done) {
    var amNext = new Amendment();
    var membersMerklePrev = [];
    var votersMerklePrev = [];
    var promoters = [];
    async.waterfall([
      function (next){
        amNext.selfGenerated = true;
        if (am) {
          ["version", "currency", "membersRoot", "membersCount", "votersRoot", "votersCount", "monetaryMass"].forEach(function(property){
            amNext[property] = am[property];
          });
          amNext.number = am.number + 1;
          amNext.previousHash = am.hash;
          amNext.generated = am.generated + conf.sync.votingFrequence;
          amNext.membersChanges = [];
          amNext.votersChanges = [];
        } else {
          amNext.version = 1;
          amNext.currency = currency;
          amNext.number = 0;
          amNext.generated = conf.sync.votingStart;
          amNext.membersChanges = [];
          amNext.membersRoot = "";
          amNext.membersCount = 0;
          amNext.votersChanges = [];
          amNext.votersRoot = "";
          amNext.votersCount = 0;
          amNext.monetaryMass = 0;
        }
        amNext.nextVotes = Math.ceil(((am && am.votersCount) || 0) * conf.sync.VotesPercent);
        // Computes changes due to too old JOIN/ACTUALIZE
        var exclusionDate = getExclusionDate(amNext);
        Membership.getCurrentJoinOrActuOlderThan(exclusionDate, next);
      },
      function (membershipsToExclude, next){
        var changes = [];
        membershipsToExclude.forEach(function(ms){
          changes.push("-" + ms.issuer);
        });
        changes.sort();
        amNext.membersChanges = changes;
        if (am) {
          Merkle.membersWrittenForAmendment(am.number, am.hash, function (err, merkle) {
            next(err, (merkle && merkle.leaves()) || []);
          });
        } else {
          next(null, []);
        }
      },
      function (leaves, next){
        membersMerklePrev = leaves;
        Merkle.membersWrittenForProposedAmendment(amNext.number, next);
      },
      function (merkle, next){
        var leaves = membersMerklePrev;
        // Remove from Merkle members not actualized
        amNext.membersChanges.forEach(function(change){
          var issuer = change.substring(1);
          var index = leaves.indexOf(issuer);
          if (~index) {
            leaves.splice(index, 1);
          }
        });
        merkle.initialize(leaves);
        amNext.membersRoot = merkle.root();
        amNext.membersCount = leaves.length;
        merkle.save(function (err) {
          next(err);
        });
      },
      function (next){
        if (am) {
          Merkle.votersWrittenForAmendment(am.number, am.hash, function (err, merkle) {
            next(err, (merkle && merkle.leaves()) || []);
          });
        } else {
          next(null, []);
        }
      },
      function (leaves, next){
        votersMerklePrev = leaves;
        var maxDate = new Date();
        // If it turns the contract is being voted for past amendments,
        // maxDate should be considered as NOW
        // Otherwise, maxDate is to be set as future amendment "GeneratedOn" datetime
        if (maxDate.timestamp() < amNext.generated) {
          maxDate.setTime(amNext.generated*1000);
        }
        if (am) {
          Vote.getForAmendment(am.number, am.hash, maxDate, next);
        }
        else {
          next(null, []);
        }
      },
      function (votes, next){
        promoters = votes;
        Merkle.votersWrittenForProposedAmendment(amNext.number, next);
      },
      function (merkle, next){
        var voters = [];
        promoters.forEach(function(vote){
          voters.push(vote.issuer);
        });
        var nonVoters = _(votersMerklePrev).difference(voters);
        nonVoters.forEach(function(leaver){
          amNext.votersChanges.push('-' + leaver);
        });
        merkle.initialize(voters);
        amNext.votersRoot = merkle.root();
        amNext.votersCount = voters.length;
        merkle.save(function (err) {
          next(err);
        });
      },
      function (next){
        // Update UD
        updateUniversalDividend(amNext, am, next);
      },
      function (next){
        // Finally save proposed amendment
        amNext.membersRoot = amNext.membersRoot || "";
        amNext.votersRoot = amNext.votersRoot || "";
        amNext.hash = amNext.getRaw().hash();
        amNext.save(function (err) {
          next(err);
        });
      },
    ], done);
  };

  this.takeCountOfVote = function (v, done) {
    async.waterfall([
      function (next){
        Amendment.current(function (err, am) {
          next(null, am ? am.number + 1 : 0);
        });
      },
      function (amNumber, next){
        Amendment.getTheOneToBeVoted(amNumber, next);
      },
      function (amNext, next){
        if (v.amendmentHash == amNext.previousHash) {
          updateVoters(amNext, { keyToUnleave: v.issuer }, next);
          return;
        }
        else next();
      },
    ], done);
  };

  this.submit = function (signedEntry, done) {
    
    async.waterfall([

      function (callback) {
        if(signedEntry.indexOf('-----BEGIN') == -1){
          callback('Signature not found in given Membership');
          return;
        }
        callback();
      },

      // Check signature's key ID
      function(callback){
        var sig = signedEntry.substring(signedEntry.indexOf('-----BEGIN'));
        var keyID = jpgp().signature(sig).issuer();
        if(!(keyID && keyID.length == 16)){
          callback('Cannot identify signature issuer`s keyID');
          return;
        }
        callback(null, keyID);
      },

      // Looking for corresponding public key
      function(keyID, callback){
        PublicKey.getTheOne(keyID, function (err, pubkey) {
          callback(err, pubkey);
        });
      },

      // Verify signature
      function(pubkey, callback){
        var entry = new Membership();
        var previous;
        var current = null;
        var nowIsIgnored = false;
        var merkleOfNextMembers;
        var amNext;
        async.waterfall([
          function (next){
            entry.parse(signedEntry, next);
          },
          function (entry, next){
            entry.verify(currency, next);
          },
          function (valid, next){
            entry.verifySignature(pubkey.raw, next);
          },
          function (verified, next){
            if(!verified){
              next('Bad signature');
              return;
            }
            if(pubkey.fingerprint != entry.issuer){
              next('Fingerprint in Membership (' + entry.issuer + ') does not match signatory (' + pubkey.fingerprint + ')');
              return;
            }
            next();
          },
          function (next){
            Membership.find({ issuer: pubkey.fingerprint, hash: entry.hash }, next);
          },
          function (entries, next){
            if (entries.length > 0) {
              next('Already received membership');
              return;
            }
            next();
          },
          function (next){
            // var timestampInSeconds = parseInt(entry.sigDate.getTime()/1000, 10);
            // Amendment.findPromotedPreceding(timestampInSeconds, next);
            Amendment.current(function (err, am) {
              next(null, am);
            });
          },
          function (am, next){
            if (am) {
              var entryTimestamp = parseInt(entry.sigDate.getTime()/1000, 10);
              if (am.generated > entryTimestamp) {
                next('Too late for this membership. Retry.');
                return;
              }
              entry.amNumber = am.number;
            } else {
              entry.amNumber = -1;
            }
            Membership.getCurrent(entry.issuer, next);
          },
          function (currentlyRecorded, next){
            current = currentlyRecorded;
            // Case new is JOIN
            if (entry.membership == 'JOIN') {
              if (current && (current.membership == 'JOIN' || current.membership == 'ACTUALIZE')) {
                next('Already joined');
                return;
              }
            }
            else if (entry.membership == 'ACTUALIZE' || entry.membership == 'LEAVE') {
              if (!current || current.membership == 'LEAVE') {
                next('Not a member currently');
                return;
              }
            }
            next();
          },
          function (next){
            // Get already existing Membership for same amendment
            Membership.getForAmendmentAndIssuer(entry.amNumber, entry.issuer, next);
          },
          function (entries, next){
            if (entries.length > 1) {
              next('Refused: already received more than one membership for next amendment.');
              return;
            } else if(entries.length > 0){
              // Already existing membership for this AM : this membership and the previous for this AM
              // are no more to be considered
              entry.eligible = false;
              previous = entries[0];
              entries[0].eligible = false;
              entries[0].save(function (err) {
                nowIsIgnored = true;
                next(err);
              });
            } else {
              next();
            }
          },
          function (next){
            // Saves entry
            entry.propagated = false;
            entry.save(function (err) {
              next(err);
            });
          },
          function (next){
            Amendment.getTheOneToBeVoted(entry.amNumber + 1, next);
          },
          function (amendmentNext, next){
            amNext = amendmentNext;
            var currentVoting, previousVoting;
            async.waterfall([
              function (next) {
                Voting.getCurrent(entry.issuer, next);
              },
              function (voting, next){
                currentVoting = voting;
                Voting.getForAmendmentAndIssuer(entry.amNumber, entry.issuer, function (err, votings) {
                  next(err, (votings && votings[0]) || null);
                });
              },
              function (voting, next){
                previousVoting = voting;
                // Impacts on changes
                if (!nowIsIgnored) {
                  deltas (entry.issuer, current, currentVoting, entry, null, exclusionDate, function (err, res) {
                    next(err, {
                      keyToAdd: res.Mdeltas.keyAdd,
                      keyToRemove: res.Mdeltas.keyRemove
                    }, {
                      keyToAdd: res.Vdeltas.keyAdd,
                      keyToRemove: res.Vdeltas.keyRemove
                    });
                  });
                }
                else {
                  // Cancelling previous
                  var membersActions = {};
                  var votersActions = {};
                  var exclusionDate = getExclusionDate(amNext);
                  async.waterfall([
                    function (next) {
                      // Unapply last changes
                      deltas (entry.issuer, current, currentVoting, previous, previousVoting, exclusionDate, next);
                    },
                    function (res, next){
                      _(membersActions).extend({
                        keyToUnadd: res.Mdeltas.keyAdd,
                        keyToUnleave: res.Mdeltas.keyRemove
                      });
                      _(votersActions).extend({
                        keyToUnadd: res.Vdeltas.keyAdd,
                        keyToUnleave: res.Vdeltas.keyRemove
                      });
                      next();
                    },
                    function (next){
                      deltas (entry.issuer, current, currentVoting, null, null, exclusionDate, next);
                    },
                    function (res, next){
                      _(membersActions).extend({
                        keyToAdd: res.Mdeltas.keyAdd,
                        keyToRemove: res.Mdeltas.keyRemove
                      });
                      _(votersActions).extend({
                        keyToAdd: res.Vdeltas.keyAdd,
                        keyToRemove: res.Vdeltas.keyRemove
                      });
                      next();
                    },
                  ], function (err) {
                    next(err, membersActions, votersActions);
                  });
                }
              },
            ], next);
          },
          function (membersActions, votersActions, next){
            async.waterfall([
              function (next){
                updateMembers(amNext, membersActions, next);
              },
              function (next){
                updateVoters(amNext, votersActions, next);
              },
              function (next) {
                // Impacts on reason
                // Impacts on tree
                if (nowIsIgnored) {
                  next('Cancelled: a previous membership was found, thus none of your memberships will be taken for next amendment');
                  return;
                }
                else next(null, entry);
              },
            ], next);
          },
        ], callback);
      }
    ], done);
  };

  this.submitVoting = function (signedEntry, done) {
    
    async.waterfall([

      function (callback) {
        if(signedEntry.indexOf('-----BEGIN') == -1){
          callback('Signature not found in given Voting');
          return;
        }
        callback();
      },

      // Check signature's key ID
      function(callback){
        var sig = signedEntry.substring(signedEntry.indexOf('-----BEGIN'));
        var keyID = jpgp().signature(sig).issuer();
        if(!(keyID && keyID.length == 16)){
          callback('Cannot identify signature issuer`s keyID');
          return;
        }
        callback(null, keyID);
      },

      // Looking for corresponding public key
      function(keyID, callback){
        PublicKey.getTheOne(keyID, function (err, pubkey) {
          callback(err, pubkey);
        });
      },

      // Verify signature
      function(pubkey, callback){
        var entry = new Voting();
        var current = null;
        var previous = null;
        var nowIsIgnored = false;
        async.waterfall([
          function (next){
            entry.parse(signedEntry, next);
          },
          function (entry, next){
            entry.verify(currency, next);
          },
          function (valid, next){
            entry.verifySignature(pubkey.raw, next);
          },
          function (verified, next){
            vlogger.debug('⬇ %s\'s voting key -> %s', "0x" + entry.issuer.substr(32), entry.votingKey);
            if(!verified){
              next('Bad signature');
              return;
            }
            if(pubkey.fingerprint != entry.issuer){
              next('Fingerprint in Voting (' + entry.issuer + ') does not match signatory (' + pubkey.fingerprint + ')');
              return;
            }
            next();
          },
          function (next){
            Voting.find({ issuer: pubkey.fingerprint, hash: entry.hash }, next);
          },
          function (entries, next){
            if (entries.length > 0) {
              next('Already received voting');
              return;
            }
            next();
          },
          function (next){
            // var timestampInSeconds = parseInt(entry.sigDate.getTime()/1000, 10);
            // Amendment.findPromotedPreceding(timestampInSeconds, next);
            Amendment.current(function (err, am) {
              next(null, am);
            });
          },
          function (am, next){
            if (am) {
              var entryTimestamp = parseInt(entry.sigDate.getTime()/1000, 10);
              if (am.generated > entryTimestamp) {
                next('Too late for this voting. Retry.');
                return;
              }
              entry.amNumber = am.number;
            } else {
              entry.amNumber = -1;
            }
            Voting.getCurrent(entry.issuer, next);
          },
          function (currentlyRecorded, next){
            current = currentlyRecorded;
            async.waterfall([
              function (next){
                Merkle.membersWrittenForProposedAmendment(entry.amNumber + 1, next);
              },
              function (merkle, next){
                if (merkle.leaves().indexOf(entry.issuer) == -1) {
                  next('Only members may be voters');
                  return;
                }
                next();
              },
            ], next);
          },
          function (next){
            // Get already existing Voting for same amendment
            Voting.getForAmendmentAndIssuer(entry.amNumber, entry.issuer, next);
          },
          function (entries, next){
            if (entries.length > 1) {
              next('Refused: already received more than one voting for next amendment.');
              return;
            } else if(entries.length > 0){
              // Already existing voting for this AM : this voting and the previous for this AM
              // are no more to be considered
              entry.eligible = false;
              previous = entries[0];
              entries[0].eligible = false;
              entries[0].save(function (err) {
                nowIsIgnored = true;
                next(err);
              });
            } else {
              next();
            }
          },
          function (next){
            Amendment.getTheOneToBeVoted(entry.amNumber + 1, next);
          },
          function (amNext, next){
            var merkleOfNextVoters;
            var currentMembership, eligibleMembership;
            async.waterfall([
              function (next) {
                Membership.getCurrent(entry.issuer, next);
              },
              function (ms, next){
                currentMembership = ms;
                Membership.getForAmendmentAndIssuer(entry.amNumber, entry.issuer, function (err, mss) {
                  next(err, (mss && mss[0]) || null);
                });
              },
              function (ms, next){
                eligibleMembership = ms;
                Merkle.votersWrittenForProposedAmendment(amNext.number, next);
              },
              function (votersMerkle, next){
                merkleOfNextVoters = votersMerkle;
                var index = merkleOfNextVoters.leaves().indexOf(entry.votingKey);
                // Case 1) key is arleady used, by the same issuer --> error
                if (~index && current && current.votingKey == entry.votingKey) {
                  next('Already used as voting key');
                  return;
                }
                // Saves entry
                entry.propagated = false;
                entry.save(function (err) {
                  next(err);
                });
              },
              function (next){
                if (!nowIsIgnored) {
                  // May be updated
                  deltas (entry.issuer, currentMembership, current, eligibleMembership, entry, null, function (err, res) {
                    next(err, amNext, {
                      keyToAdd: res.Vdeltas.keyAdd,
                      keyToRemove: res.Vdeltas.keyRemove
                    });
                  });
                }
                else {
                  // Cancelling previous
                  var votersActions = {};
                  async.waterfall([
                    function (next) {
                      // Unapply last changes
                      deltas (entry.issuer, currentMembership, current, eligibleMembership, previous, null, next);
                    },
                    function (res, next){
                      _(votersActions).extend({
                        keyToUnadd: res.Vdeltas.keyAdd,
                        keyToUnleave: res.Vdeltas.keyRemove
                      });
                      next();
                    },
                    function (next){
                      deltas (entry.issuer, currentMembership, current, eligibleMembership, null, null, next);
                    },
                    function (res, next){
                      _(votersActions).extend({
                        keyToAdd: res.Vdeltas.keyAdd,
                        keyToRemove: res.Vdeltas.keyRemove
                      });
                      next();
                    },
                  ], function (err) {
                    next(err, amNext, votersActions);
                  });
                  return;
                }
              },
              function (amNext, votersActions, next){
                updateVoters(amNext, votersActions, next);
              },
              function (next) {
                if (nowIsIgnored) {
                  next('Cancelled: a previous voting was found, thus none of your voting requests will be taken for next amendment');
                  return;
                }
                else next(null, entry);
              },
            ], next);
          },
        ], callback);
      }
    ], done);
  };

  this.getVote = function (amNumber, done) {
    async.waterfall([
      function (next){
        Vote.getSelf(amNumber, next);
      },
      function (vote, next){
        if (vote){
          next(null, vote);
          return;
        }
        // Tries to vote
        var now = new Date();
        async.waterfall([
          function (next){
            Amendment.getTheOneToBeVoted(amNumber, next);
          },
          function (amNext, next){
            if (now.timestamp() >= amNext.generated) {

              var privateKey = pgp.keyring.privateKeys[0];
              var cert = jpgp().certificate(this.ascciiPubkey);
              var raw = amNext.getRaw();
              async.waterfall([
                function (next){
                  jpgp().signsDetached(raw, privateKey, next);
                },
                function (signature, next){
                  var signedAm = raw + signature;
                  vucoin(conf.ipv6 || conf.ipv4 || conf.dns, conf.port, false, false, function (err, node) {
                    next(null, signedAm, node);
                  });
                },
                function (vote, node, next){
                  node.hdc.amendments.votes.post(vote, next);
                },
                function (json, next){
                  var am = new Amendment(json.amendment);
                  var issuer = cert.fingerprint;
                  var hash = json.signature.unix2dos().hash();
                  var basis = json.amendment.number;
                  Vote.getByIssuerHashAndBasis(issuer, hash, basis, next);
                },
                function (vote, next){
                  if (!vote) {
                    next('Self vote was not found');
                    return;
                  }
                  vote.selfGenerated = true;
                  vote.save(function  (err) {
                    next(err, vote);
                  });
                },
              ], next);
              return;
            }
            next('Not yet');
          },
        ], next);
      },
    ], done);
  };

  function getExclusionDate (amNext) {
    var nextTimestamp = amNext.generated;
    var exclusionDate = new Date();
    exclusionDate.setTime(nextTimestamp*1000 - conf.sync.ActualizeFrequence*1000);
    return exclusionDate;
  }

  function updateUniversalDividend (amNext, amCurrent, done) {
    // Time for Universal Dividend
    var delayPassedSinceRootAM = (amNext.generated - conf.sync.votingStart);
    if (delayPassedSinceRootAM > 0 && delayPassedSinceRootAM % conf.sync.UDFrequence == 0) {
      async.waterfall([
        function (next) {
          Amendment.getPreviouslyPromotedWithDividend(next);
        },
        function (previousWithUD, next){
          var currentMass = (amCurrent && amCurrent.monetaryMass) || 0;
          var monetaryMassDelta = currentMass * conf.sync.UDPercent;
          var dividendPerMember = monetaryMassDelta / amNext.membersCount;
          var previousUD = (previousWithUD && previousWithUD.dividend) || conf.sync.UD0;
          amNext.dividend = Math.max(previousUD, Math.floor(dividendPerMember)); // Integer
          amNext.monetaryMass += amNext.dividend * amNext.membersCount; // Integer
          amNext.save(function (err) {
            next(err);
          });
        },
      ], done);
    }
    else done(null);
  }

  function updateMembers (amNext, actions, done) {
    async.waterfall([
      function (next){
        Merkle.membersWrittenForProposedAmendment(amNext.number, next);
      },
      function (membersMerkle, next){
        merkle = membersMerkle;
        // Additions
        if (actions.keyToAdd) {
          merkle.push(actions.keyToAdd);
        }
        if (actions.keyToUnleave) {
          merkle.push(actions.keyToUnleave);
        }
        // Deletions
        if (actions.keyToUnadd) {
          merkle.remove(actions.keyToUnadd);
        }
        if (actions.keyToRemove) {
          merkle.remove(actions.keyToRemove);
        }
        amNext.membersRoot = merkle.root();
        amNext.membersCount = merkle.leaves().length;
        merkle.save(function (err) {
          next(err);
        });
      },
      function(next){
        // Update changes
        if (actions.keyToRemove) {
          amNext.membersChanges.push('-' + actions.keyToRemove);
        }
        if (actions.keyToUnleave) {
          var index = amNext.membersChanges.indexOf('-' + actions.keyToUnleave);
          if (~index) {
            amNext.membersChanges.splice(index, 1);
          }
        }
        if (actions.keyToAdd) {
          amNext.membersChanges.push('+' + actions.keyToAdd);
        }
        if (actions.keyToUnadd) {
          var index = amNext.membersChanges.indexOf('+' + actions.keyToUnadd);
          if (~index) {
            amNext.membersChanges.splice(index, 1);
          }
        }
        next();
      },
      function (next) {
        Amendment.current(function (err, am) {
          next(null, am);
        });
      },
      function (currentAm, next){
        // Update UD
        updateUniversalDividend(amNext, currentAm, next);
      },
      function (next){
        amNext.membersChanges.sort();
        amNext.membersRoot = amNext.membersRoot || "";
        amNext.votersRoot = amNext.votersRoot || "";
        amNext.hash = amNext.getRaw().hash();
        amNext.save(function (err) {
          next(err);
        });
      },
    ], done);
  }

  function updateVoters(amNext, actions, done){
    async.waterfall([
      function (next) {
        // Check if other votings are using this key
        async.parallel({
          keyRemoval: function(callback){
            if (!actions.keyToRemove) {
              callback();
              return;
            }
            Voting.getEligiblesUsingKey(actions.keyToRemove, amNext, function (err, members) {
              // Does it stays other members using the key?
              if (members.length > 0) {
                actions.keyToRemove = null;
              }
              callback();
            });
          },
          keyUnadd: function(callback){
            if (!actions.keyToUnadd) {
              callback();
              return;
            }
            Voting.getEligiblesUsingKey(actions.keyToUnadd, amNext, function (err, members) {
              // Does it stays other members using the key?
              if (members.length > 0) {
                actions.keyToUnadd = null;
              }
              callback();
            });
          },
          keyToAdd: function(callback){
            if (!actions.keyToAdd) {
              callback();
              return;
            }
            Voting.getEligiblesUsingKey(actions.keyToAdd, amNext, function (err, members) {
              // How much are using this key?
              if (members.length > 1) {
                actions.keyToAdd = null;
              }
              callback();
            });
          }
        }, function (err) {
          next(err);
        });
      },
      function (next) {
        Merkle.votersWrittenForProposedAmendment(amNext.number, next);
      },
      function (merkle, next){
        // Specific case: if have to add while key is already with a "-", add become UnLeave
        if (actions.keyToAdd) {
          var index = amNext.votersChanges.indexOf('-' + actions.keyToAdd);
          if (~index) {
            actions.keyToUnleave = actions.keyToAdd;
            actions.keyToAdd = null;
          }
        }
        // Specific case: if have to unadd while key is not present become ToRemove
        if (actions.keyToUnadd) {
          var index = amNext.votersChanges.indexOf('+' + actions.keyToUnadd);
          if (index == -1) {
            actions.keyToRemove = actions.keyToUnadd;
            actions.keyToUnadd = null;
          }
        }
        //--------------------
        // Update keys according to what is to be added/removed
        if (actions.keyToRemove) {
          merkle.remove(actions.keyToRemove);
        }
        if (actions.keyToUnadd) {
          merkle.remove(actions.keyToUnadd);
        }
        if (actions.keyToUnleave) {
          merkle.push(actions.keyToUnleave);
        }
        if (actions.keyToAdd) {
          merkle.push(actions.keyToAdd);
        }
        // Update resulting root + count
        amNext.votersRoot = merkle.root();
        amNext.votersCount = merkle.leaves().length;
        merkle.save(function (err) {
          next(err);
        });
      },
      function (next){
        // Update changes
        if (actions.keyToRemove) {
          amNext.votersChanges.push('-' + actions.keyToRemove);
        }
        if (actions.keyToUnleave) {
          var index = amNext.votersChanges.indexOf('-' + actions.keyToUnleave);
          if (~index) {
            amNext.votersChanges.splice(index, 1);
          }
        }
        if (actions.keyToAdd) {
          amNext.votersChanges.push('+' + actions.keyToAdd);
        }
        if (actions.keyToUnadd) {
          var index = amNext.votersChanges.indexOf('+' + actions.keyToUnadd);
          if (~index) {
            amNext.votersChanges.splice(index, 1);
          }
        }
        next();
      },
      function (next){
        amNext.votersChanges.sort();
        amNext.membersRoot = amNext.membersRoot || "";
        amNext.votersRoot = amNext.votersRoot || "";
        amNext.nextVotes = Math.ceil((amNext.votersCount || 0) * conf.sync.VotesPercent);
        amNext.hash = amNext.getRaw().hash();
        amNext.save(function (err) {
          next(err);
        });
      },
    ], done);
  }

  function deltas (issuer, membershipA, votingA, membershipR, votingR, exclusionDate, done) {
    // Members deltas
    var Mdeltas = {};
    // Voters deltas
    var Vdeltas = {};
    // Integrity controls
    // No previous MS
    if (!membershipA && membershipR && membershipR.membership != 'JOIN') {
      done('Cannot have other than JOIN membership for first request');
      return;
    }
    // With previous MS
    if (membershipA && membershipR && membershipA.membership == 'JOIN' && membershipR.membership == 'JOIN') {
      done('Cannot have other than ACTUALIZE or LEAVE after JOIN');
      return;
    }
    if (membershipA && membershipR && membershipA.membership == 'ACTUALIZE' && membershipR.membership == 'JOIN') {
      done('Cannot have other than ACTUALIZE or LEAVE after ACTUALIZE');
      return;
    }
    if (membershipA && membershipR && membershipA.membership == 'LEAVE' && membershipR.membership != 'JOIN') {
      done('Cannot have other than JOIN after LEAVE');
      return;
    }

    // -------------
    // Membership part
    // -------------
    var willBeMember = membershipA && membershipA.membership != 'LEAVE';
    // No renewal + too old membership
    if (!membershipR && membershipA && membershipA.sigDate < exclusionDate) {
      Mdeltas.keyRemove = issuer;
      willBeMember = false;
    }
    // Join
    if (membershipR && membershipR.membership == 'JOIN') {
      Mdeltas.keyAdd = issuer;
      willBeMember = true;
    }
    // Leave
    if (membershipR && membershipR.membership == 'LEAVE') {
      Mdeltas.keyRemove = issuer;
      willBeMember = false;
    }

    // -------------
    // Voting part
    // -------------
    if (willBeMember) {
      if (votingR) {
        if (votingA) {
          Vdeltas.keyRemove = votingA.votingKey;
        }
        Vdeltas.keyAdd = votingR.votingKey;
      }
    } else {
      if (votingA) {
        Vdeltas.keyRemove = votingA.votingKey;
      }
    }

    done(null, { "Mdeltas": Mdeltas, "Vdeltas": Vdeltas });
  }

  return this;
}
