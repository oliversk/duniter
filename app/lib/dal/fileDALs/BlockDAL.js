/**
 * Created by cgeek on 22/08/15.
 */

var Q = require('q');
var _ = require('underscore');

module.exports = BlockDAL;

function BlockDAL(fileDAL, loki) {

  "use strict";

  let collection = loki.getCollection('blocks') || loki.addCollection('blocks', { indices: ['fork', 'number', 'hash'] });
  let blocksDB = getView();

  this.init = () => null;

  this.getCurrent = () => Q(blocksDB.branchResultset().simplesort('number', true).limit(1).data()[0]);

  this.getBlock = (number) => Q(blocksDB.branchResultset().find({ number: parseInt(number) }).data()[0]);

  this.blocksDB = blocksDB;
  this.collection = collection;

  this.getLastSavedBlockFileNumber = () => {
    let last = collection.chain().simplesort('number', true).limit(1).data()[0];
    if (last) return Q(last.number);
    return Q(-1);
  };

  let conf;

  this.setConf = (conf2) => conf = conf2;

  this.saveBlock = (block) => {
    if (conf && conf.branchesWindowSize == 0) {
      block.fork = false;
      //console.log('--> MAIN -->', _.pick(block, 'number', 'hash'));
      collection.insert(block);
    } else {
      block.fork = !!fileDAL.parentDAL;
      let existing;
      existing = collection.find({
        $and: [{
          number: block.number
        }, {
          hash: block.hash
        }]
      })[0];
      if (existing) {
        existing.fork = block.fork;
        collection.update(existing);
      } else {
        //console.log('--> BRAN -->', _.pick(block, 'number', 'hash'));
        collection.insert(block);
      }
    }
    return Q(block);
  };

  function getView() {
    let view;
    if (!fileDAL.parentDAL) {
      // Main branch
      view = collection.addDynamicView('mainBranch');
      view.applyFind({ fork: false });
    }
    else {
      let blocks = [], p = fileDAL;
      while (p) {
        if (p.core) {
          blocks.push(p.core);
        }
        p = p.parentDAL;
      }
      blocks = _.sortBy(blocks, (b) => b.number);
      let conditions = blocks.map((b) => {
        return { $and: [{
        fork: true
      }, {
        number: b.forkPointNumber
      }, {
        hash: b.forkPointHash
      }] }; });
      conditions.unshift({ fork: false });
      view = collection.addDynamicView(['branch', fileDAL.name].join('_'));
      view.applyFind({ '$or': conditions });
      view.conditions = conditions;
    }
    return view;
  }
}
