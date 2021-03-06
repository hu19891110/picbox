var mysql = require('mysql');
var bcrypt = require('bcrypt');
var redis = require('redis');
var debug = require('debug')('storage');
var Q = require('q');

var Storage = function (mysqlConfig, redisConfig) {
  this.host = mysqlConfig.host;
  this.user = mysqlConfig.user;
  this.password = mysqlConfig.password;
  this.database = mysqlConfig.database;

  // connection is not established here. it is established implicitly by invoking a query
  this.handleDisconnect = function () {
    this.connection = mysql.createConnection({
      host: this.host,
      user: this.user,
      password: this.password,
      database: this.database
    });

    this.connection.on('error', function(err) {
      console.error('db error', err);
      if(err.code === 'PROTOCOL_CONNECTION_LOST') { // Connection to the MySQL server is usually
        this.handleDisconnect();                         // lost due to either server restart, or a
      } else {                                      // connnection idle timeout (the wait_timeout
        throw err;                                  // server variable configures this)
      }
    });
  }

  this.handleDisconnect();

  this.redisClient = redis.createClient(redisConfig.port, redisConfig.host);

  this.getRedisCacheKey = function (userID) {
    return 'picbox.' + userID + '.saved';
  };

  this.getUserSavedCountKey = function (userID) {
    return 'picbox.' + userID + '.saved.count';
  };

  this.totalSavedCountKey = 'picbox.total.saved.count';
};

Storage.prototype.terminate = function () {
  this.connection.end();
  this.redisClient.quit();
};

Storage.prototype.createUser = function (email, password) {
  var deferred = Q.defer();
  var _this = this;
  bcrypt.genSalt(10, function(err, salt) {
    bcrypt.hash(password, salt, function(err, hash) {
      _this.connection.query('INSERT INTO users SET ?', {email: email, password: hash}, function (err, result) {
        if (err) {
          if (err.hasOwnProperty('code') && err.code == 'ER_DUP_ENTRY') {
            // email address has already been registered
            deferred.reject({email_exists: true});
          } else {
            deferred.reject(err);
          }
        } else {
          deferred.resolve(result.insertId);
        }
      });
    });
  });
  return deferred.promise;
};

Storage.prototype.getUser = function (email, password, cb) {
  if (arguments.length == 2 && typeof arguments[0] == 'number' && typeof arguments[1] == 'function') {
    // called with `ìd` parameter for deserialization
    var id = email;
    cb = password;
    this.connection.query('SELECT * FROM users WHERE ?', {id: id}, function (err, result) {
      if (err) throw err;

      if (result.length != 1) {
        return cb({not_exists: true});
      }

      return cb(null, result[0]);
    });
  } else {
    this.connection.query('SELECT * FROM users WHERE ?', {email: email}, function (err, result) {
      if (err) throw err;

      if (result.length === 0) {
        return cb({not_exists: true});
      }

      bcrypt.compare(password, result[0].password, function(err, match) {
        if (err) throw err;

        if (match) {
          cb(null, result[0]);
        } else {
          cb({incorrect_password: true});
        }
      });
    });
  }
};

Storage.prototype.getUsers = function (limit) {
  limit = limit || 500;
  var deferred = Q.defer();
  this.connection.query('SELECT id, email, instagram_id, instagram_token, dropbox_id, dropbox_token FROM users LIMIT ?', [limit], function (err, results) {
    if (err) {
      deferred.reject(err);
    } else {
      deferred.resolve(results);
    }
  });
  return deferred.promise;
};

Storage.prototype.saveInstagramInfo = function (email, igm, cb) {
  this.connection.query('UPDATE users SET ? WHERE ?',
  [
    {instagram_id: igm.userID, instagram_token: igm.accessToken},
    {email: email}
  ],
  function (err, result) {
    if (err) throw err;
    cb(result.changedRows);
  });
};

Storage.prototype.saveDropboxInfo = function (email, dbx, cb) {
  this.connection.query('UPDATE users SET ? WHERE ?',
  [
    {dropbox_id: dbx.userID, dropbox_token: dbx.accessToken},
    {email: email}
  ],
  function (err, result) {
    if (err) throw err;
    cb(result.changedRows);
  });
};

Storage.prototype.removeInstagramInfo = function (email) {
  var deferred = Q.defer();

  this.connection.query('UPDATE users SET ? WHERE ?', [{instagram_id: null, instagram_token: null}, {email: email}], function (err, result) {
    if (err) {
      deferred.reject(err);
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
};

Storage.prototype.removeDropboxInfo = function (email) {
  var deferred = Q.defer();

  this.connection.query('UPDATE users SET ? WHERE ?', [{dropbox_id: null, dropbox_token: null}, {email: email}], function (err, result) {
    if (err) {
      deferred.reject(err);
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
};

Storage.prototype.incUserSavedCount = function (userID, count) {
  var deferred = Q.defer();

  this.redisClient.incrby(this.getUserSavedCountKey(userID), count, function (err, reply) {
    if (err) throw err;

    deferred.resolve(!!reply);
  });

  return deferred.promise;
};

Storage.prototype.incTotalSavedCount = function (count) {
  var deferred = Q.defer();

  this.redisClient.incrby(this.totalSavedCountKey, count, function (err, reply) {
    if (err) throw err;

    deferred.resolve(!!reply);
  });

  return deferred.promise;
};

Storage.prototype.getTotalSavedCount = function () {
  var deferred = Q.defer();

  this.redisClient.get(this.totalSavedCountKey, function (err, reply) {
    if (err) throw err;

    deferred.resolve(reply);
  });

  return deferred.promise;

};

Storage.prototype.checkMediaSaved = function (userID, mediaID) {
  var deferred = Q.defer();

  var savedLikesKey = this.getRedisCacheKey(userID);
  this.redisClient.zscore(savedLikesKey, mediaID, function (err, reply) {
    if (err) throw err;

    deferred.resolve(!!reply);
  });

  return deferred.promise;
};

Storage.prototype.saveLikedMedia = function (userID, mediaIDArr, replace) {
  var deferred = Q.defer();
  replace = replace === true ? true : false;
  var savedLikesKey = this.getRedisCacheKey(userID);
  var score = Date.now();

  var args = [savedLikesKey];
  if (!(mediaIDArr instanceof Array)) {
    mediaIDArr = [mediaIDArr];
  }
  mediaIDArr.forEach(function (mediaID) {
    args.push(score, mediaID);
  });

  var _this = this;

  if (replace) {
    this.redisClient.del(savedLikesKey, function (err, reply) {
      if (err) throw err;
      _this.redisClient.zadd(args, function (err, reply) {
        if (err) throw err;
        deferred.resolve();
      });
    });
  } else {
    this.redisClient.zadd(args, function (err, reply) {
      if (err) throw err;
      deferred.resolve();
      // _this.redisClient.zcard(savedLikesKey, function (err, setCount) {
      //   console.log('current card ', setCount);
      //   if (setCount > 20) {
      //     var remCount = setCount - 20;
      //     console.log('to remove: '+remCount);
      //     _this.redisClient.zremrangebyrank(savedLikesKey, 0, remCount - 1, function (err, reply) {
      //       if (err) throw err;
      //       deferred.resolve();
      //     });
      //   } else {
      //     deferred.resolve();
      //   }
      // });
    });
  }

  return deferred.promise;
};

Storage.prototype.deleteLikedCache = function (userID) {
  var deferred = Q.defer();
  var savedLikesKey = this.getRedisCacheKey(userID);
  this.redisClient.del(savedLikesKey, function (err, reply) {
    if (err) throw err;
    deferred.resolve();
  });
  return deferred.promise;
};

Storage.prototype.setLastSync = function (userID, timestamp) {
  var deferred = Q.defer();
  this.connection.query('UPDATE users SET ? WHERE ?', [{last_sync: timestamp}, {id: userID}], function (err, result) {
    if (err) throw err;
    deferred.resolve();
  });

  return deferred.promise;
};

module.exports = Storage;
