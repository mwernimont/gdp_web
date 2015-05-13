var GDP = GDP || {};

GDP.ADVANCED = GDP.ADVANCED || {};

GDP.ADVANCED.view = GDP.ADVANCED.view || {};

(function() {
	"use strict";
	GDP.ADVANCED.view.HubView = GDP.util.BaseView.extend({

		EMAIL_WHEN_FINISHED_ALGORITHM : 'gov.usgs.cida.gdp.wps.algorithm.communication.EmailWhenFinishedAlgorithm',

		events: {
			'click #edit-spatial-btn' : 'goToSpatialPage',
			'click #edit-detail-btn' : 'goToDataDetailsPage',
			'click #edit-process-btn' : 'goToProcessPage',
			'click #submit-job-btn' : 'submitProcessingRequest',
			'click #retrieve-output-btn' : 'downloadResults',
			'click #retrieve-input-btn' : 'downloadProcessInputs'
		},

		render: function () {
			var process = this.model.getSelectedAlgorithmProcess();
			var messages = this.model.jobErrorMessages();
			var invalidJob = (messages.spatial.length !== 0) || (messages.dataDetails.length !== 0) || (messages.algorithm.length !== 0);
			this.$el.html(this.template({
				jobModel: this.model.attributes,
				selectedProcess : (process) ? process.attributes : '',
				processInputs : this.model.getProcessInputs(),
				messages : messages,
				invalidJob : invalidJob
			}));
		},

		initialize : function(options) {
			this.wps = options.wps;
			GDP.util.BaseView.prototype.initialize.apply(this, arguments);
			this.spatialMapView = new GDP.ADVANCED.view.HubSpatialMapView({
				model : this.model,
				mapDiv : 'hub-spatial-inset-map'
			});
			this.alertView = new GDP.util.AlertView({
				el : '#job-processing-messages-div'
			});

			// Used to store retrieval results id
			this.resultsModel = new Backbone.Model();
		},

		remove : function() {
			this.spatialMapView.remove();
			GDP.util.BaseView.prototype.remove.apply(this, arguments);
		},

		goToSpatialPage : function() {
			this.router.navigate('/spatial', {trigger : true});
		},

		goToDataDetailsPage : function() {
			this.router.navigate('/datadetail', {trigger : true});
		},

		goToProcessPage : function() {
			this.router.navigate('/process', {trigger: true});
		},

		setEditable : function(editable) {
			$('#edit-spatial-btn').prop('disabled', !editable);
			$('#edit-detail-btn').prop('disabled', !editable);
			$('#edit-process-btn').prop('disabled', !editable);
		},

		submitProcessingRequest : function() {
			var executePromise;
			var mimeType = this.model.getMimeType();

			var self = this;

			var getWPSXMLInputs = this.model.getWPSXMLInputs();
			var getWPSStringInputs = this.model.getWPSStringInputs();

			var submitDone = $.Deferred();

			GDP.logger.debug("Starting submission process");

			this.setEditable(false);
			$('#submit-job-btn').prop('disabled', true);

			$.when(getWPSXMLInputs, getWPSStringInputs).done(function(xmlInputs, wpsStringInputs) {
				self.alertView.show('alert-info', 'Process status: started');

				executePromise = self.wps.sendWpsExecuteRequest(
					GDP.config.get('application').endpoints.processWps + '/WebProcessingService',
					self.model.get('algorithmId'),
					wpsStringInputs,
					['OUTPUT'],
					true,
					{
						'FEATURE_COLLECTION' : [self.wps.createWfsWpsReference(GDP.config.get('application').serviceEndpoints.geoserver + '/wfs', xmlInputs)]
					},
					false,
					'xml',
					mimeType
				);

				executePromise.done(function(xml) {
					var statusCallback = function(xmlText) {
						// Workaround and extra logging for bug where empty xml is returned.
						// Ignore it and keep rechecking.
						var xml;

						if (!xmlText || xmlText === '') {
							logger.warn('GDP: RetrieveResultServlet returned empty response. Retrying.');
							return;
						}
						xml = $.parseXML(xmlText);

						if ($(xml).find('wps\\:ProcessStarted, ProcessStarted').length > 0) {
							GDP.logger.debug('GDP Status: Process started');
							self.alertView.show('alert-info', 'Process status: in progess. Last checked: ' + (new Date()).toTimeString());
						}
						else if ($(xml).find('wps\\:ProcessSucceeded, ProcessSucceeded').length > 0) {
							window.clearInterval(intervalId);
							self.alertView.show('alert-success', 'Process status: complete');
							var outputURL = $(xml).find('wps\\:Output, Output').find('wps\\:Reference, Reference').attr('href');
							var outputURLAndData = outputURL.split('?');
							self.resultsModel.set({
								'outputURL' : outputURLAndData[0],
								'outputData' : outputURLAndData[1]
							});
							submitDone.resolve();
						}
						else if ($(xml).find('wps\\:ProcessFailed, ProcessFailed').length > 0) {
							window.clearInterval(intervalId);
							var message = 'GDP: STATUS: Process Failed: ' + $(xml).find('wps\\:ProcessFailed, ProcessFailed').find('ows\\:ExceptionText, ExceptionText').text();
							self.alertView.show('alert-danger', 'Process failed: ' + message);
							GDP.logger.warn('GDP: STATUS: Process failed: ' + message);
							submitDone.reject();
						}
						else {
							GDP.logger.warn('GDP: Status: Bad response received');
							self.alertView.show('alert-info', 'Process status: Unknown response received. Retrying, Last checked: ' + (new Date()).toTimeString());
						}
					};
					var statusLocation = $(xml).find('wps\\:ExecuteResponse, ExecuteResponse').attr('statusLocation');
					var statusID = (statusLocation.split('?')[1]).split('id=')[1];
					self.resultsModel.set('statusId', statusID);

					// If user would like to be notified by email send an additional execute request
					var email = self.model.get('email');
					var filename;
					var emailWPSInputs;
					if (email) {
						emailWPSInputs = {
							'wps-checkpoint' : [statusLocation],
							'email' : [email]
						};
						filename = self.model.get('filename');
						if (filename) {
							emailWPSInputs.filename = [filename];
						}

						self.wps.sendWpsExecuteRequest(
							GDP.config.get('application').endpoints.utilityWps + '/WebProcessingService',
							self.EMAIL_WHEN_FINISHED_ALGORITHM,
							emailWPSInputs,
							['result'],
							false
						).fail(function(xhr, textStatus, errorMessages) {
							self.alertView('alert-warning', 'Request for email notification failed : ' + textStatus);
						});
					}

					var intervalId = window.setInterval(function() {
						$.ajax({
							url: GDP.config.get('application').endpoints.processWps + '/RetrieveResultServlet',
							data : {
								'id': statusID
							},
							success : function (data, textStatus, XMLHttpRequest) {
								statusCallback(XMLHttpRequest.responseText);
							},
							error : function() {
								self.alertView.show('alert-warning', 'Status request error. Submission failed');
								window.clearInterval(intervalId);
							}
						});
					}, 5000);
				}).fail(function(jqXhr, errorThrown, errorMessage) {
					self.alertView.show('alert-danger', 'Process status: Failed with ' + errorMessage);
					submitDone.reject();
				});
			});

			submitDone.always(function() {
				self.setEditable(true);
			}).done(function() {
				$('#job-processing-div').hide();
				$('#job-results-div').show();
			}).fail(function() {
				$('#submit-job-btn').prop('disabled', false);
			});
		},

		downloadResults : function() {
			var url = this.resultsModel.get('outputURL');
			var data = this.resultsModel.get('outputData');
			var filename = this.model.get('filename');
			var data = data + ((filename) ? '&filename=' + filename : '');
			$.download(url, data, 'get');
		},

		downloadProcessInputs : function() {
			var url = this.resultsModel.get('outputURL');
			var statusId = this.resultsModel.get('statusId');
			var data = 'id=' + statusId + '&attachment=true';
			$.download(url, data, 'get');
		}

	});
}());
