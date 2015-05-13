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

GDP.ADVANCED = GDP.ADVANCED || {};

GDP.ADVANCED.view = GDP.ADVANCED.view || {};


(function() {
	"use strict";
	GDP.ADVANCED.view.SpatialView = GDP.util.BaseView.extend({

		events : {
			'change #select-aoi' : 'changeName',
			'change #select-attribute' : 'changeAttribute',
			'change #select-values' : 'changeValues',
			'click #draw-polygon-btn' : 'toggleDrawControl',
			'click #draw-submit-btn' : 'saveDrawnPolygons',
			'click #draw-clear-btn' : 'clearDrawnPolygons',
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
			this.wps = options.wps;
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

			// Set up file uploader
			var params = {
				maxfilesize : 167772160,
				'response.encoding' : 'xml',
				'filename.param' : 'qqfile',
				'use.crs.failover' : 'true',
				'projection.policy' : 'reproject'
			};

			$('#upload-shapefile-input').fileupload({
				url : 'uploadhandler?' +  $.param(params),
				type: 'POST',
				dataType: 'xml',
				send : function(e, data) {
					data.url = data.url + '&qqfile=' + data.files[0].name;
					$('#upload-indicator').show();
				},
				done : function(e, data) {
					$('#upload-indicator').hide();

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
							self.model.set('aoiName', layer);
						},
						function() {
							self.alertView('alert-error', 'Unable to read uploaded shapefile attributes.');
						});

					}
					else {
						var error = $resp.find('error').first().text();
						var exception = $resp.find('exception').first().text();
						self.alertView.show('alert-danger', 'File Upload error: ' + error + '. ' + exception);
					}

				},
				fail : function(e, data) {
					$('#upload-indicator').hide();
					self.alertView.show('alert-error', 'Upload failed');
				}
			});

			//Set up draw control by creating a feature layer with a save strategy.
			this.saveStrategy = new OpenLayers.Strategy.Save();
			this.saveStrategy.events.register('success', null, function() {
				// Now need to add an attribute so that GDP can use this feature
				var featureType = self.drawFeatureLayer.protocol.featureType;
				var attribute = 'ID';
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
					url: GDP.config.get('application').endpoints.geoserver + '/wfs',
					type: 'POST',
					contentType: 'application/xml',
					data: updateTransaction,
					success : function() {
						self.toggleDrawControl();
					},
					error : function(jqXHR, textStatus, errorThrown) {
						self.alertView.show('alert-danger', 'Could not update the drawn feature ' + featureType + ' with error ' + textStatus);
					}
				}).done(function() {
					self.getAvailableFeatures().done(function() {
						self.model.set('aoiName', featureType);
						self.model.set('aoiAttribute', attribute);
					});
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
					url: GDP.config.get('application').endpoints.geoserver + '/wfs',
					featureNS :  'gov.usgs.cida.gdp.draw',
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

			// get features, attributes, and values
			var name = self.model.get('aoiName');
			var attribute = self.model.get('aoiAttribute');
			var values = self.model.get('aoiAttributeValues');

			var getDeferreds = [];
			getDeferreds.push(this.getAvailableFeatures());
			getDeferreds.push(this._updateAttributes(name));
			getDeferreds.push(this._updateValues(name, attribute));
			$.when.apply(this, getDeferreds).done(function() {
				self._updateAOILayer(name);
				self._highlightFeatures(name, attribute, values);

				$('#select-aoi').val(name);
				$('#select-attribute').val(attribute);
				$('#select-values').val(values);

				self.listenTo(self.model, 'change:aoiName', self.updateSelectedAoiName);
				self.listenTo(self.model, 'change:aoiAttribute', self.updateSelectedAoiAttribute);
				self.listenTo(self.model, 'change:aoiAttributeValues', self.updateSelectedAoiAttributeValues);
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

		updateSelectedAoiName : function() {
			var name = this.model.get('aoiName');
			var needsAoiAttributeValues = this.model.needsAoiAttributeValues();
			var self = this;
			$('#select-aoi').val(name);
			self._updateAOILayer(name);

			this._setVisibility($('#aoi-attribute-div'), needsAoiAttributeValues);
			this._setVisibility($('#aoi-attribute-values-div'), needsAoiAttributeValues);

			if (needsAoiAttributeValues) {
				this._updateAttributes(name);
			}
			else {
				this.model.set('aoiAttribute', 'ID');
			}

			// This will clear out any highlighted layer
			this._highlightFeatures(name, '', '');
		},

		updateSelectedAoiAttribute : function() {
			var self = this;
			var name = this.model.get('aoiName');
			var attribute = this.model.get('aoiAttribute');
			$('#select-attribute').val(attribute);
			this._updateValues(name, attribute).done(function(data) {
				self.model.set('aoiAttributeValues', data);
			});
		},

		updateSelectedAoiAttributeValues : function() {
			var name = this.model.get('aoiName');
			var attribute = this.model.get('aoiAttribute');
			var values = this.model.get('aoiAttributeValues');

			$('#select-values').val(values);
			this._highlightFeatures(name, attribute, values);
		},

		changeName : function(ev) {
			this.model.set('aoiExtent', GDP.util.mapUtils.transformWGS84ToMercator(GDP.OGC.WFS.getBoundsFromCache(ev.target.value)));
			this.model.set('aoiName', ev.target.value);
		},

		changeAttribute : function(ev) {
			this.model.set('aoiAttribute', ev.target.value);
		},

		changeValues : function(ev) {
			var aoiAttributeValues = _.pluck(ev.target.selectedOptions, 'text');
			this.model.set('aoiAttributeValues', aoiAttributeValues);
		},

		toggleDrawControl : function() {
			var $toggle = $('#draw-polygon-btn');
			var turnDrawOn = !$toggle.hasClass('active');

			this.drawFeatureLayer.setVisibility(turnDrawOn);
			if (turnDrawOn) {
				this.drawFeatureControl.activate();
				$('#draw-polygon-div').show();
				$toggle.addClass('active');
			}
			else {
				this.drawFeatureLayer.removeAllFeatures();
				this.drawFeatureControl.deactivate();

				$('#draw-polygon-div').hide();
				$toggle.removeClass('active');
			}
		},

		saveDrawnPolygons : function(ev) {
			var self = this;
			var name = $('#polygon-name-input').val();
			if (this.drawFeatureLayer.features.length === 0) {
				this.alertView.show('alert-warning', 'Must draw at least one polygon.');
				return;
			}

			if (!name) {
				this.alertView.show('alert-warning', 'Please specify a name for the feature drawn');
				$('#polygon-name-input').focus();
				return;
			}

			if (/\W/.test(name) || /^[^A-Za-z]/.test(name)) {
				this.alertView.show('alert-warning', 'Name must begin with a letter, and may only contain letters, numbers, and underscores.');
				$('#polygon-name-input').focus();
				return;
			}

			//Update the feature with the name entered
			this.drawFeatureLayer.protocol.setFeatureType(name);

			// Create the a datastore for the new shapefile
			var wpsInputs = {
				name : [name]
			};
			var wpsOutputs = ['layer-name'];
			this.wps.sendWpsExecuteRequest(
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

		clearDrawnPolygons : function(ev) {
			this.drawFeatureLayer.removeAllFeatures();
		},

		_updateAOILayer : function(name) {
			var name = this.model.get('aoiName');

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
		 * @return Deferred which is always resolved when the DescribeFeatureType request is done and the attributes have been updated.
		 */
		_updateAttributes : function(name) {
			var self = this;
			var deferred = $.Deferred();

			this.attributeSelectMenuView.$el.val(null);
			this.attributeSelectMenuView.updateMenuOptions([]);

			if ((name) && (this.model.needsAoiAttributeValues())) {
				var getDescribeFeature = GDP.OGC.WFS.callWFS(
					{
						request : 'DescribeFeatureType',
						typename : name
					}
				);
				getDescribeFeature.done(function(data) {
					var $elements = $(data).find('xsd\\:complexContent, complexContent').find('xsd\\:element[name!="the_geom"], element[name!="the_geom"]');
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
		 * @return jquery.Deferred which will be resolved when the values have been updated.
		 */
		_updateValues : function(name, attribute) {
			var self = this;
			var deferred = $.Deferred();
			var getFeatureDeferred;
			var ns_attribute = name.slice(0, name.indexOf(':'));

			this.attributeValuesSelectMenuView.$el.val(null);
			this.attributeValuesSelectMenuView.updateMenuOptions([]);

			if ((name) && (attribute)) {
				getFeatureDeferred = GDP.OGC.WFS.callWFS(
					{
						request : 'GetFeature',
						typename : name,
						propertyname : attribute,
						maxFeatures : 5001 // Limits number of features shown in selection menu
					}
				);
				getFeatureDeferred.done(function(data) {
					// Don't repeat values in the list
					var optionValues = _.uniq(
						_.map($(data).find(ns_attribute + '\\:' + attribute + ', ' + attribute), function(datum) {
							return $(datum).text();
						})
					);

					var optionObjects = _.map(optionValues, function(optionValue){
						return {
							text: optionValue,
							value: optionValue
						}
					});
					self.attributeValuesSelectMenuView.updateMenuOptions(optionObjects);
					self.attributeValuesSelectMenuView.$el.val(optionValues);

					deferred.resolve(optionValues);
				}).fail(function(message) {
					GDP.logger.error(message);
					deferred.resolve([]);
				});
			}
			else {
				deferred.resolve([]);
			}

			return deferred;
		},

		_highlightFeatures : function(name, attribute, values) {
			if (name) {
				if (!this.model.needsAoiAttributeValues() || ((attribute) && (values.length !== 0))) {
					var filter = GDP.util.mapUtils.createAOICQLFilter(attribute, values);
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
			}
			if (this.highlightLayer) {
				this.map.removeLayer(this.highlightLayer);
				this.highlightLayer = null;
			}
		},

		_setVisibility : function($el, isVisible) {
			var $inputs = $el.find(':input');
			if (isVisible) {
				$el.show();
				$inputs.removeProp('disabled')
			}
			else {
				$el.hide();
				$inputs.prop('disabled', true);
			}
		}
	});
}());



