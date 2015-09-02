var path = require("path");
var appRoot = require('app-root-path');
var Promise = require("bluebird");
var fse = Promise.promisifyAll(require('fs-extra'));
var logger = require('strong-logger');
var processor = require('./processor');
var repo = require('./repo');
var github = require('./github');
var pt = require('../../server/libs/papertrail');

var url = require('url');
var kue = require('kue');

if (process.env.REDIS_URL) {
  var redisURL = url.parse(process.env.REDIS_URL);
  var queue = kue.createQueue({
    prefix: 'q',
    redis: {
      port: redisURL.port,
      host: redisURL.hostname,
      auth: redisURL.auth.split(":")[1]
    }
  });
} else {
  var queue = kue.createQueue();
}

/*
* Watch for any errors in the queue
*/
queue.on( 'error', function( err ) {
  logger.error('The queue threw an error: ' + error);
});

/*
* Submit job for processing
*/
exports.submitJob = function(job){
 var job = queue.create('submit', {
   title: 'job ' + job.id,
   job: job
 });

 job
   .on('enqueue', function (){
     pt.log('[queue] job has been added to the queue.', job.data.job.id);
     logger.info('[job-'+job.data.job.id+'] job has been added to the queue.');
   })
   .on('complete', function (){
     pt.log('[queue] job exited the queue successfully.', job.data.job.id);
     logger.info('[job-'+job.data.job.id+'] job completed the queue successfully.');
   })
   .on('failed', function (err){
     pt.log('[queue] job failed in the queue with the following error: ' + err, job.data.job.id);
     logger.error('[job-'+job.data.job.id+'] job failed in the queue with the following error: ' + err);
   })
 job.save();
}

queue.process('submit', function (job, done){
  var jobId = job.data.job.id;
  pt.log('[queue] job has started processing.', jobId);
  logger.info('[job-'+jobId+'] job has started processing.');
  processor.downloadZip(job.data.job)
    .then(repo.addJobProperties)
    .then(repo.addBuildProperties)
    .then(repo.addShellAssets)
    .then(github.push)
    .then(processor.sendJobSubmittedMail)
    .then(function() {
      done(null, 'Code successfully pushed to github for processing.');
    }).catch(function(err) {
      logger.error('[job-'+jobId+'] queue error: ' + err);
      // rollback the job and environment to previous state if there was an error
      processor.rollback(jobId)
        .then(processor.sendJobErrorMail)
        .then(function(){
         return done(err);
       })
    }).finally(function(){
      // clean up after ourselves by deleting downloading directories & keys
      fse.removeSync(path.resolve(appRoot.path, '/tmp/' + jobId));
      fse.removeSync(path.resolve(appRoot.path, '/tmp/keys/' + jobId));
    });
});

/*
* Submit test job for processing
*/
exports.submitTest = function(job){
 var job = queue.create('test', {
   job: job
 });

 job
   .on('enqueue', function (){
     logger.info('[test] job has been added to the queue.');
   })
   .on('complete', function (){
     logger.info('[test] job exited the queue successfully.');
   })
   .on('failed', function (err){
     logger.info('[test] job failed in the queue with the following error: ' + err);
   })
 job.save();
}

queue.process('test', function (job, done){
  logger.info('[test] submitted successfully and finished processing');
  done && done();
});