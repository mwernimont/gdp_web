/*jslint browser: true*/
/*global _*/
/*global $*/
/*global OpenLayers*/
/*global GDP.util.BaseView*/
/*global GDP.util.SelectMenuView*/
/*global GDP.util.mapUtils*/
/*global GDP.OGC.WFS*/
/*global GDP.config*/

var GDP = GDP || {};

GDP.PROCESS_CLIENT = GDP.PROCESS_CLIENT || {};

GDP.PROCESS_CLIENT.view = GDP.PROCESS_CLIENT.view || {};


(function() {
	"use strict";
	GDP.PROCESS_CLIENT.view.SpatialView = GDP.util.BaseView.extend({

		_DRAW_FEATURE_NS : 'draw',
		_DRAW_FEATURE_ATTRIBUTE : 'ID',

		events : {
			'change #select-aoi' : 'changeName',
			'change #select-attribute' : 'changeAttribute',
			'change #select-values' : 'changeValues',
			'click #draw-polygon-btn' : 'toggleDrawControl',
			'click #draw-submit-btn' : 'saveDrawnPolygons',
			'click #draw-clear-btn' : 'clearDrawnPolygons',
			'submit form' : 'goToHubPage'
		},

		render : function() {
			GDP.util.BaseView.prototype.render.apply(this, arguments);
			this.map.render('spatial-map');
			this.map.zoomToExtent(new OpenLayers.Bounds(GDP.config.get('map').extent.conus['3857']), true);

			// Create selection menus
			this.nameSelectMenuView = new GDP.util.SelectMenuView({
				el : '#select-aoi',
				emptyPlaceholder : true,
				sortBy : 'text'
			});
			this.attributeSelectMenuView = new GDP.util.SelectMenuView({
				el : '#select-attribute',
				emptyPlaceholder : true,
				sortBy : 'text'
			});
			this.attributeValuesSelectMenuView = new GDP.util.SelectMenuView({
				el : '#select-values',
				sortBy : 'text'
			});
		},

		initialize : function(options) {
			var self = this;
			this.context = {
				enable_upload_and_drawing : (!_.has(GDP.incomingParams, 'feature_wms') || !_.has(GDP.incomingParams, 'feature_wfs'))
			};
			this.routePrefix = options.datasetId ? '#!catalog/gdp/dataset/' + options.datasetId  : '#!advanced';

			var baseLayers = [GDP.util.mapUtils.createWorldStreetMapLayer()];
			var controls = [
				new OpenLayers.Control.Navigation(),
				new OpenLayers.Control.MousePosition({
					prefix: 'POS: ',
					numDigits: 2,
					displayProjection: GDP.util.mapUtils.WGS84_GEOGRAPHIC
				}),
				new OpenLayers.Control.ScaleLine({
					geodesic: true
				}),
				new OpenLayers.Control.Zoom()
			];

			this.aoiLayer = null;
			this.highlightLayer = null;

			this.map = GDP.util.mapUtils.createMap(baseLayers, controls);

			GDP.util.BaseView.prototype.initialize.apply(this, arguments);

			this.alertView = new GDP.util.AlertView({
				el : '#messages-div'
			});

			this._createFileUploader($('#upload-shapefile-input'), $('#upload-indicator'));
			this._createDrawPolygonControl();

			// get features, attributes, and values
			var name = self.model.get('aoiName');
			var attribute = self.model.get('aoiAttribute');
			var values = self.model.get('aoiAttributeValues');

			var needsAoiAttributeValues = this._needsAoiAttributeValues();
			this._setVisibility(this.$el.find('#aoi-attribute-div'), needsAoiAttributeValues);
			this._setVisibility(this.$el.find('#aoi-attribute-values-div'), needsAoiAttributeValues);

			var getDeferreds = [];
			getDeferreds.push(this.getAvailableFeatures());
			if (needsAoiAttributeValues) {
				getDeferreds.push(this._updateAttributes(name));
				getDeferreds.push(this._updateValues(name, attribute));
			}
			getDeferreds.push(this.model.updateDataSetModel(options.datasetId));
			$.when.apply(this, getDeferreds).done(function() {
				self._updateAOILayer(name);
				self._highlightFeatures(name, attribute, values);

				self._addDatasetBoundingBoxLayer();

				self.$el.find('#select-aoi').val(name);
				self.$el.find('#select-attribute').val(attribute);
				self.$el.find('#select-values').val(values);

				self.listenTo(self.model, 'change:aoiName', self.updateSelectedAoiName);
				self.listenTo(self.model, 'change:aoiAttribute', self.updateSelectedAoiAttribute);
				self.listenTo(self.model, 'change:aoiAttributeValues', self.updateSelectedAoiAttributeValues);
			}).fail(function() {
				self.alertView.show('alert-danger', 'Unable to load information about the dataset, ' + options.datasetId);
			});

		},

		/*
		 *	Makes a WFS GetCapabilities call to determine what areas of interest are available and fills in the selection menu.
		 * @ return {jquery.Deferred}. If resolved returns the data received. If rejected returns the error message.
		 */
		getAvailableFeatures : function() {
			var getDeferred = GDP.OGC.WFS.callWFS({
				request : 'GetCapabilities'
			});
			var self = this;

			getDeferred.done(function(data) {
					self.nameSelectMenuView.$el.val(null);
					var optionValues = _.map($(data).find('FeatureType'), function(el) {
						var text = $(el).find('Name').text();
						return {
							text : text,
							value : text
						};
					});

					self.nameSelectMenuView.updateMenuOptions(optionValues);
				}).fail(function(message) {
					GDP.logger.error(message);
				});
			return getDeferred;
		},

		/*
		 * Updates the selected AOI menu and the AOI shown on the map. Determine if the AOI attribute
		 * values need to be specified and update the DOM and model. Clears out any highlighted layer
		 * @returns {undefined}
		 */
		updateSelectedAoiName : function() {
			var name = this.model.get('aoiName');
			var needsAoiAttributeValues = this._needsAoiAttributeValues();
			this.$el.find('#select-aoi').val(name);
			this._updateAOILayer(name);

			this._setVisibility(this.$el.find('#aoi-attribute-div'), needsAoiAttributeValues);
			this._setVisibility(this.$el.find('#aoi-attribute-values-div'), needsAoiAttributeValues);

			if (needsAoiAttributeValues) {
				this._updateAttributes(name);
				this.model.set('aoiAttribute', '');
			}
			else {
				this.model.set('aoiAttribute', this._DRAW_FEATURE_ATTRIBUTE);
			}
		},

		/*
		 * Updates the selected AOI attribute in the DOM, retrieves the values for the selected
		 * attributes and updates the model's aoiAttributeValues with this array of values
		 * @returns {undefined}
		 */
		updateSelectedAoiAttribute : function() {
			var self = this;
			var name = this.model.get('aoiName');
			var attribute = this.model.get('aoiAttribute');
			this.$el.find('#select-attribute').val(attribute);
			if (this._needsAoiAttributeValues()) {
				this._updateValues(name, attribute).done(function(data) {
					self.model.set('aoiAttributeValues', data);
				});
			}
			else {
				self.model.set('aoiAttributeValues', self.model.SELECT_ALL_AOI_ATTRIBUTE_VALUES);
			}
		},

		/*
		 * Updates the DOM to show the aoiAttributeValues in the model. Updates the highlight feature
		 * layer to show the selected features in the area of interest.
		 * @returns {undefined}
		 */
		updateSelectedAoiAttributeValues : function() {
			var name = this.model.get('aoiName');
			var attribute = this.model.get('aoiAttribute');
			var values = this.model.get('aoiAttributeValues');

			this.$el.find('#select-values').val(values);
			this._highlightFeatures(name, attribute, values);
		},

		/*
		 * Updates the model attributes aoiExtent and aoiName with the value in ev
		 * @param {Jquery.event} ev
		 * @returns {undefined}
		 */
		changeName : function(ev) {
			this.model.set('aoiExtent', GDP.util.mapUtils.transformWGS84ToMercator(GDP.OGC.WFS.getBoundsFromCache(ev.target.value)));
			this.model.set('aoiName', $(ev.target).val());
		},

		/*
		 * Updates the model's aoiAttributes withe value in ev
		 * @param {Jquery.event} ev
		 * @returns {undefined}
		 */
		changeAttribute : function(ev) {
			this.model.set('aoiAttribute', $(ev.target).val());
		},

		/*
		 * Updates the model's aoiAttributeValues array with the values in ev.
		 * @param {Jquery.event} ev
		 * @returns {undefined}
		 */
		changeValues : function(ev) {
			var aoiAttributeValues = $(ev.target).val();
			this.model.set('aoiAttributeValues', aoiAttributeValues);
		},

		/*
		 * Activate/Deactivate's the draw control
		 * @returns {undefined}
		 */
		toggleDrawControl : function() {
			var $toggle = this.$el.find('#draw-polygon-btn');
			var $div = this.$el.find('#draw-polygon-div');
			var turnDrawOn = !$toggle.hasClass('active');

			this.drawFeatureLayer.setVisibility(turnDrawOn);
			if (turnDrawOn) {
				this.drawFeatureControl.activate();
				$div.show();
				$toggle.addClass('active');
			}
			else {
				this.drawFeatureLayer.removeAllFeatures();
				this.drawFeatureControl.deactivate();

				$div.hide();
				$toggle.removeClass('active');
			}
		},

		/*
		 * Saves the drawn polygon after verifying that all necessary information has been entered.
		 * @returns {undefined}
		 */
		saveDrawnPolygons : function() {
			var self = this;

			var $nameInput = this.$el.find('#polygon-name-input');
			var name = $nameInput.val();
			if (this.drawFeatureLayer.features.length === 0) {
				this.alertView.show('alert-warning', 'Must draw at least one polygon.');
				return;
			}

			if (!name) {
				this.alertView.show('alert-warning', 'Please specify a name for the feature drawn');
				$nameInput.focus();
				return;
			}

			if (/\W/.test(name) || /^[^A-Za-z]/.test(name)) {
				this.alertView.show('alert-warning', 'Name must begin with a letter, and may only contain letters, numbers, and underscores.');
				$nameInput.focus();
				return;
			}

			//Update the feature with the name entered
			this.drawFeatureLayer.protocol.setFeatureType(name);

			// Create the a datastore for the new shapefile
			var wpsInputs = {
				name : [name]
			};
			var wpsOutputs = ['layer-name'];
			GDP.wpsClient.sendWpsExecuteRequest(
				GDP.config.get('application').endpoints.utilityWps + '/WebProcessingService',
				'gov.usgs.cida.gdp.wps.algorithm.filemanagement.CreateNewShapefileDataStore',
				wpsInputs,
				wpsOutputs,
				false
			).done(function() {
				self.saveStrategy.save();
			}).fail(function(errors) {
				self.alertView.show('alert-danger', 'Could not save the drawn polygon with error: ' + _.last(errors));
			});

		},

		/*
		 * Remove any drawn features
		 * @returns {undefined}
		 */
		clearDrawnPolygons : function() {
			this.drawFeatureLayer.removeAllFeatures();
		},

		/*
		 * Route back to the hub page.
		 * @param {Jquery event} ev
		 * @returns {undefined}
		 */
		goToHubPage : function(ev) {
			ev.preventDefault();
			this.router.navigate(this.routePrefix, {trigger : true});
		},

		/*
		 * Returns true when the user must specify attribute values to select features.
		 * @returns {Boolean}
		 */
		_needsAoiAttributeValues : function() {
			var namespace = this.model.get('aoiName').split(':')[0];
			return (namespace !== this._DRAW_FEATURE_NS);
		},

		/*
		 * Updates the AOI layer to show the layer, name, and sets the extent to the aoi's bounds.
		 * @param {String} name
		 * @returns {undefined}
		 */
		_updateAOILayer : function(name) {
			if (name) {
				if (this.aoiLayer) {
					this.aoiLayer.mergeNewParams({
						layers : name
					});
				}
				else {
					this.aoiLayer = GDP.util.mapUtils.createAOILayer(name);
					this.map.addLayer(this.aoiLayer);
				}

				// zoom map to extent of the feature.
				this.map.zoomToExtent(this.model.get('aoiExtent'), true);
			}
			else if (this.aoiLayer) {
				this.map.removeLayer(this.aoiLayer);
				this.aoiLayer = null;
			}
		},

		/*
		 * Makes a service call to retrieve the attributes for feature name.
		 * @return Deferred.promise which is always resolved when the DescribeFeatureType request is done and the attributes have been updated.
		 */
		_updateAttributes : function(name) {
			var self = this;
			var deferred = $.Deferred();

			this.attributeSelectMenuView.$el.val(null);
			this.attributeSelectMenuView.updateMenuOptions([]);

			if (name) {
				var getDescribeFeature = GDP.OGC.WFS.callWFS(
					{
						request : 'DescribeFeatureType',
						typename : name
					}
				);
				getDescribeFeature.done(function(data) {
					var $complexContent = GDP.util.findXMLNamespaceTags($(data), 'xsd:complexContent');
					var $elements = GDP.util.findXMLNamespaceTags($complexContent, 'xsd:element[name!="the_geom"]');
					var optionValues = _.map($elements, function(el) {
						var name = $(el).attr('name');
						return {
							text : name,
							value: name
						};
					});

					self.attributeSelectMenuView.updateMenuOptions(optionValues);
					deferred.resolve();
				}).fail(function(message) {
					GDP.logger.error(message);
					deferred.resolve();
				});
			}
			else {
				deferred.resolve();
			}

			return deferred.promise();
		},

		/*
		 * Makes a service call to retrieve the attribute values for feature name for attribute. Updates
		 * the AOI attribute selection menu and selects all of the values.
		 * @param {String} name
		 * @param {String} attribute
		 * @return jquery.Deferred.promise which will be resolved with {Array of Object} option values. If the service call
		 * the deferred is resolved with an empty array.
		 */
		_updateValues : function(name, attribute) {
			var self = this;
			var messageDiv = $('#attribute-values-exceeded-div');
			var deferred = $.Deferred();
			var getFeatureDeferred;
			var ns_attribute = name.slice(0, name.indexOf(':'));

			this.attributeValuesSelectMenuView.$el.val(null);
			this.attributeValuesSelectMenuView.updateMenuOptions([]);

			if ((name) && (attribute)) {
				this.model.set('aoiAttributeFeatureIds', []);
				getFeatureDeferred = GDP.OGC.WFS.callWFS(
					{
						request : 'GetFeature',
						typename : name.replace(ns_attribute + ':', ''),
						propertyname : attribute,
						maxFeatures : 5001 // Limits number of features shown in selection menu
					}
				);
				getFeatureDeferred.done(function(data) {
					var aoiAttributeFeatureIds = [];
					var featureInfo = GDP.util.findXMLNamespaceTags($(data), name);
					var optionValues;
					var optionObjects;
					// Create a list of values with associate ids. Rather than
					// repeat values, push the id onto the id key for that value
					featureInfo.each(function(){
						var value = GDP.util.findXMLNamespaceTags($(this), ns_attribute + ':' + attribute).text();
						var id = $(this).attr('gml:id');
						var index = _.findIndex(aoiAttributeFeatureIds, function(e) {
							return e.value === value;
						});
						// Don't repeat values in the list
						if (index > -1) {
							aoiAttributeFeatureIds[index].ids.push(id);
						}
						else {
							aoiAttributeFeatureIds.push({
								value : value,
								ids : [id]
							});
						}
					});

					// Limits the number of polygons that can be sent in a processing request - GDP-205
					if (featureInfo.length < parseInt(GDP.config.get('application').maxPolygonsToShowAttributeValues)) {
						self._setVisibility(self.attributeValuesSelectMenuView.$el, true);
						messageDiv.hide();
						optionObjects = _.map(aoiAttributeFeatureIds, function(e){
							return {
								text: e.value,
								value: e.value
							};
						});
						optionValues = _.pluck(optionObjects, 'value');
						self.attributeValuesSelectMenuView.updateMenuOptions(optionObjects);
						self.attributeValuesSelectMenuView.$el.val(optionValues);

						self.model.set('aoiAttributeFeatureIds', aoiAttributeFeatureIds);
					}
					else {
						// We have exceeded the limit so we won't show the attribute value selection. Instead show a message indicating why.
						self._setVisibility(self.attributeValuesSelectMenuView.$el, false);
						messageDiv.show();
						optionValues = self.model.SELECT_ALL_AOI_ATTRIBUTE_VALUES;

					}
				    self.model.set('aoiAttributeFeatureIds', aoiAttributeFeatureIds);
					deferred.resolve(optionValues);

				}).fail(function(message) {
					GDP.logger.error(message);
					deferred.resolve([]);
				});
			}
			else {
				this._setVisibility(this.attributeValuesSelectMenuView.$el, true);
				messageDiv.hide();
				deferred.resolve([]);
			}

			return deferred.promise();
		},

		/*
		 * Highlights the selected features in the AOI  on the map. If no features are selected remove the
		 * highlight layer from the map.
		 * @param {String} name
		 * @param {String} attribute
		 * @param {String} values
		 */
		_highlightFeatures : function(name, attribute, values) {
			if ((name) && (attribute) && (values.length !== 0)) {
				var filter = GDP.util.mapUtils.createCQLFilter(attribute, values);
				if (this.highlightLayer) {
					this.highlightLayer.mergeNewParams({
						layers : name,
						cql_filter : filter
					});
					if (!filter) {
						delete this.highlightLayer.params.CQL_FILTER;
					}
				}
				else {
					this.highlightLayer = GDP.util.mapUtils.createAOIFeaturesLayer(name, filter);
					this.map.addLayer(this.highlightLayer);
				}
				return;
			}
			if (this.highlightLayer) {
				this.map.removeLayer(this.highlightLayer);
				this.highlightLayer = null;
			}
		},

		/*
		 * Sets up the file loader plugin.
		 * @param {Jquery element} $fileUploaderInput
		 * @param {Jquery element} $uploadIndicator
		 */
		_createFileUploader : function($fileUploaderInput, $uploadIndicator) {
			var self = this;
			var params = {
				'maxfilesize' : 167772160,
				'response.encoding' : 'xml',
				'filename.param' : 'qqfile',
				'use.crs.failover' : 'true',
				'projection.policy' : 'reproject'
			};

			$fileUploaderInput.fileupload({
				url : GDP.BASE_URL + 'uploadhandler?' +  $.param(params),
				type: 'POST',
				dataType: 'xml',
				send : function(e, data) {
					data.url = data.url + '&qqfile=' + data.files[0].name;
					$uploadIndicator.show();
				},
				done : function(e, data) {
					$uploadIndicator.hide();

					var $resp = $(data.result);
					// Determine if the response indicated an error
					var success = $resp.find('success').first().text();
					if (success === 'true') {
						var warning = $resp.find('warning').first().text();
						var layer = $resp.find('name').first().text();

						if (warning) {
							self.alertView.show('alert-warning', 'Upload succeeded with warning ' + warning);
						}
						else {
							self.alertView.show('alert-success', 'Upload was successful.');
						}

						self.getAvailableFeatures().then(function() {
							$('#select-aoi').val(layer);
							self.model.set('aoiExtent', GDP.util.mapUtils.transformWGS84ToMercator(GDP.OGC.WFS.getBoundsFromCache(layer)));
							self.model.set('aoiName', layer);
						},
						function() {
							self.alertView('alert-danger', 'Unable to read uploaded shapefile attributes.');
						});

					}
					else {
						var error = $resp.find('error').first().text();
						var exception = $resp.find('exception').first().text();
						self.alertView.show('alert-danger', 'File Upload error: ' + error + '. ' + exception);
					}

				},
				fail : function(e, data) {
					$uploadIndicator.hide();
					self.alertView.show('alert-danger', 'Upload failed');
				}
			});
		},
		/**
		 * Asynchronously recalculates the bounding box for the specified feature
		 * @param {String} workspace
		 * @param {String} store
		 * @param {String} layer
		 * @returns {jqXHR} a promise
		 */
		_recalculateFeatureBoundingBox: function(workspace, store, layer){
			var params = {
				'workspace' : workspace,
				'store': store,
				'layer': layer,
				'response.encoding' : 'json'
			};

			var deferred = $.ajax({
				url: GDP.BASE_URL + 'recalculatebbox?' +  $.param(params),
				type: 'GET'
			});
			return deferred;
		},
		/*
		 * Create the draw control and draw feature layer and add to the map. set up the save strategy to update the saved
		 * feature and to alert the user when the save is successful or if it has failed. If the save
		 * is successful the model is updated so that the new feature is selected.
		 */
		_createDrawPolygonControl : function() {
			var self = this;

			this.saveStrategy = new OpenLayers.Strategy.Save();
			this.saveStrategy.events.register('success', null, function() {
				// Now need to add an attribute so that GDP can use this feature
				var layerName = self.drawFeatureLayer.protocol.featureType;
				var featureType = self._DRAW_FEATURE_NS + ':' + layerName;
				var attribute = self._DRAW_FEATURE_ATTRIBUTE;
				var value = 0;

				var updateTransaction =
					'<?xml version="1.0"?>' +
					'<wfs:Transaction xmlns:ogc="http://www.opengis.net/ogc" ' +
					'xmlns:wfs="http://www.opengis.net/wfs" ' +
					'xmlns:gml="http://www.opengis.net/gml" ' +
					'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
					'version="1.1.0" service="WFS" '+
					'xsi:schemaLocation="http://www.opengis.net/wfs ../wfs/1.1.0/WFS.xsd">' +
					'<wfs:Update typeName="' + featureType + '">' +
					'<wfs:Property>' +
					'<wfs:Name>' + attribute + '</wfs:Name>' +
					'<wfs:Value>' + value + '</wfs:Value>'+
					'</wfs:Property>'+
					'</wfs:Update>'+
					'</wfs:Transaction>';

				$.ajax({
					url: GDP.config.get('application').endpoints.wfs,
					type: 'POST',
					contentType: 'application/xml',
					data: updateTransaction
				}).done(function() {
					self.toggleDrawControl();
					
					//recalculate assume layer and store name are identical
					var recalculation = self._recalculateFeatureBoundingBox(self._DRAW_FEATURE_NS, layerName, layerName);
					recalculation.fail(function(jqXHR, textStatus, errorThrown){
						self.alertView.show('alert-danger', 'Could not recalculate the bounding box for drawn feature ' + featureType + ' with error ' + textStatus);
					}).always(
						/* 
						 * Now that we have attempted to recalculate the bounding box,
						 * fetch the new bbox and update the model.
						 * Even if the bbox recalculation failed, it is better to
						 * execute this so that at least the other client-side 
						 * attributes can be synched with the server
						 */
						function(){
							self.getAvailableFeatures().done(function() {
								self.model.set('aoiExtent', GDP.util.mapUtils.transformWGS84ToMercator(GDP.OGC.WFS.getBoundsFromCache(featureType)));
								self.model.set('aoiName', featureType);
								self.model.set('aoiAttribute', attribute);
							});
						});
				}).fail(function(jqXHR, textStatus, errorThrown){
					self.alertView.show('alert-danger', 'Could not update the drawn feature ' + featureType + ' with error ' + textStatus);
				});

			});
			this.saveStrategy.events.register('fail', null, function() {
				self.alertView.show('alert-danger', 'Unable to save polygon');
			});
			this.drawFeatureLayer = new OpenLayers.Layer.Vector('Draw Polygon Layer', {
				strategies: [new OpenLayers.Strategy.BBOX(), this.saveStrategy],
				projection: new OpenLayers.Projection('EPSG:4326'),
				protocol: new OpenLayers.Protocol.WFS({
					version: '1.1.0',
					srsName: 'EPSG:4326',
					url: GDP.config.get('application').endpoints.wfs,
					featureNS :  'gov.usgs.cida.gdp.' + this._DRAW_FEATURE_NS,
					featureType : "dummy-" + new Date().getTime() + '', // this gets changed before submitting geometry
					geometryName: 'the_geom'
				})
			});
			this.map.addLayer(this.drawFeatureLayer);

			this.drawFeatureControl = new OpenLayers.Control.DrawFeature(
				this.drawFeatureLayer,
				OpenLayers.Handler.Polygon,
				{
					multi : true
				}
			);
		    this.map.addControl(this.drawFeatureControl);
		},

		_addDatasetBoundingBoxLayer : function() {
			if (!(_.has(this.boundsLayer))) {
				var self = this;
				var dataSetModel = this.model.get('dataSetModel');
				var dataSourceUrl = this.model.get('dataSourceUrl');
				var bounds;

				if (dataSetModel.has('identifier') && dataSetModel.has('bounds')) {
					bounds = dataSetModel.get('bounds');
					if (dataSourceUrl) {
						GDP.util.mapUtils.createDataSourceExtentLayer(bounds, dataSetModel.get('identifier'), dataSourceUrl).done(function(layer) {
							self.boundsLayer = layer;
							self.map.addLayer(self.boundsLayer);
						});

					}
					else {
						this.boundsLayer = GDP.util.mapUtils.createDataSetExtentLayer(bounds);
						this.map.addLayer(this.boundsLayer);
					}

				}
			}
		},

		/*
		 * Set the visiblity of $el and remove/add required attribute from $el or any of its child inputs.
		 * @param {Jquery.element} $el
		 * @param {Boolean} isVisible
		 */
		_setVisibility : function($el, isVisible) {
			var $inputs;
			if ($el.is(':input')) {
				$inputs = $el;
			}
			else {
				$inputs = $el.find(':input');
			}

			if (isVisible) {
				$el.show();
				$inputs.attr('required', 'required');
			}
			else {
				$el.hide();
				$inputs.removeAttr('required');
			}
		}
	});
}());



